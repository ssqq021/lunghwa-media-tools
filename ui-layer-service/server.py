import gc
import io
import os
import shutil
import threading
import time
from pathlib import Path

import torch
from flask import Flask, jsonify, request
from PIL import Image, UnidentifiedImageError
from werkzeug.exceptions import RequestEntityTooLarge

from ui_layer_core import (
    choose_auto_layer_count,
    clamp_layer_count,
    png_data_url,
    prepare_output_layers,
)


MODEL_ID = "Qwen/Qwen-Image-Layered"
HOST = os.environ.get("UI_LAYER_HOST", "127.0.0.1")
PORT = int(os.environ.get("UI_LAYER_PORT", "7862"))
MAX_UPLOAD_BYTES = int(os.environ.get("UI_LAYER_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
MAX_IMAGE_PIXELS = int(os.environ.get("UI_LAYER_MAX_IMAGE_PIXELS", str(20_000_000)))
MODEL_CACHE = Path(
    os.environ.get("UI_LAYER_CACHE_DIR", Path(__file__).resolve().parent / ".model-cache")
)
ALLOWED_ORIGINS = {
    "https://ssqq021.github.io",
    "https://lunghwa.cn",
    "https://www.lunghwa.cn",
    "null",
}
ALLOWED_ORIGIN_PREFIXES = ("http://127.0.0.1", "http://localhost")

os.environ.setdefault("HF_HOME", str(MODEL_CACHE))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "1800")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "60")
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

pipeline = None
model_status = "not_started"
model_message = "本地模型尚未准备。"
model_error = None
model_lock = threading.Lock()
infer_lock = threading.Lock()
inference_progress = 0
DOWNLOAD_ATTEMPTS = 3


class ApiError(RuntimeError):
    status_code = 400


class ServiceUnavailableError(ApiError):
    status_code = 503


class UnsupportedMediaTypeError(ApiError):
    status_code = 415


class ForbiddenOriginError(ApiError):
    status_code = 403


def is_allowed_origin(origin):
    if not origin or origin in ALLOWED_ORIGINS:
        return True
    return origin.startswith(ALLOWED_ORIGIN_PREFIXES)


@app.before_request
def validate_request():
    origin = request.headers.get("Origin", "")
    if not is_allowed_origin(origin):
        raise ForbiddenOriginError("不允许该网页来源访问本地拆图服务。")
    if request.method == "OPTIONS":
        return ("", 204)
    return None


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "")
    if is_allowed_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin or "null"
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.errorhandler(RequestEntityTooLarge)
def handle_upload_too_large(_error):
    return jsonify(error=f"图片超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 限制。"), 413


@app.errorhandler(ApiError)
def handle_api_error(error):
    return jsonify(error=str(error)), error.status_code


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    app.logger.exception("UI layer request failed")
    return jsonify(error=f"本地 UI 拆图服务处理失败：{error}"), 500


def service_info():
    return {
        "ok": True,
        "ready": pipeline is not None,
        "status": model_status,
        "message": model_message,
        "error": model_error,
        "progress": inference_progress,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU",
        "model": MODEL_ID,
        "cache_dir": str(MODEL_CACHE),
        "model_download_gb": 53.8,
        "service_url": f"http://{HOST}:{PORT}",
    }


def set_model_state(status, message, error=None):
    global model_status, model_message, model_error
    model_status = status
    model_message = message
    model_error = error


def directory_size(path):
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def is_retryable_download_error(error):
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "connection",
            "incompleteread",
            "read timed out",
            "readtimeout",
            "remote end closed",
            "temporarily unavailable",
        )
    )


def load_model():
    global pipeline
    with model_lock:
        if pipeline is not None or model_status in {"downloading", "loading"}:
            return

        try:
            if not torch.cuda.is_available():
                raise RuntimeError("未检测到可用的 NVIDIA CUDA 显卡。")

            reusable_bytes = directory_size(MODEL_CACHE)
            free_bytes = shutil.disk_usage(MODEL_CACHE.parent).free
            if free_bytes + reusable_bytes < 60 * 1024**3:
                raise RuntimeError("模型首次下载至少需要 60GB 可用磁盘空间。")

            set_model_state("downloading", "正在下载或读取本地模型，首次准备需要较长时间……")

            from diffusers import QwenImageLayeredPipeline
            from diffusers.quantizers import PipelineQuantizationConfig

            quantization = PipelineQuantizationConfig(
                quant_backend="bitsandbytes_4bit",
                quant_kwargs={
                    "load_in_4bit": True,
                    "bnb_4bit_quant_type": "nf4",
                    "bnb_4bit_use_double_quant": True,
                    "bnb_4bit_compute_dtype": torch.bfloat16,
                },
                components_to_quantize=["transformer", "text_encoder"],
            )
            set_model_state("loading", "正在以 4 位模式加载模型到显卡和内存……")
            loaded = None
            for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
                try:
                    loaded = QwenImageLayeredPipeline.from_pretrained(
                        MODEL_ID,
                        cache_dir=str(MODEL_CACHE),
                        quantization_config=quantization,
                        torch_dtype=torch.bfloat16,
                        low_cpu_mem_usage=True,
                        max_workers=2,
                    )
                    break
                except Exception as error:
                    if attempt == DOWNLOAD_ATTEMPTS or not is_retryable_download_error(error):
                        raise
                    set_model_state(
                        "downloading",
                        f"网络中断，正在自动续传（{attempt}/{DOWNLOAD_ATTEMPTS - 1}）……",
                    )
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    time.sleep(attempt * 3)

            loaded.enable_model_cpu_offload(gpu_id=0)
            loaded.set_progress_bar_config(disable=True)
            pipeline = loaded
            set_model_state("ready", "本地模型已经就绪。")
        except Exception as error:
            pipeline = None
            set_model_state("error", "本地模型准备失败。", str(error))


def start_model_loader():
    if model_status in {"not_started", "error"}:
        threading.Thread(
            target=load_model,
            daemon=True,
            name="ui-layer-model-loader",
        ).start()


def image_from_request():
    uploaded = request.files.get("file")
    if uploaded is None:
        raise ApiError("请选择一张需要拆分的图片。")

    raw = uploaded.read()
    if not raw:
        raise ApiError("上传的图片为空。")

    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError):
        raise UnsupportedMediaTypeError("只支持 PNG、JPG 和 WebP 图片。") from None

    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise ApiError(f"图片像素数量不能超过 {MAX_IMAGE_PIXELS:,}。")

    return image.convert("RGBA")


def resolve_layer_count(image):
    requested = request.form.get("layers", "auto")
    if requested == "auto":
        return choose_auto_layer_count(image)
    try:
        return clamp_layer_count(requested)
    except ValueError as error:
        raise ApiError(str(error)) from None


def run_decomposition(image, mode, layers, quality):
    global inference_progress
    if pipeline is None:
        raise ServiceUnavailableError(model_error or "本地模型尚未就绪，请先点击“准备本地模型”。")

    resolution = 1024 if quality == "high" else 640
    steps = 50 if quality == "high" else 30
    inference_progress = 0

    def update_progress(_pipe, step, _timestep, callback_kwargs):
        global inference_progress
        inference_progress = min(99, round(((step + 1) / steps) * 100))
        return callback_kwargs

    generator_device = "cuda" if torch.cuda.is_available() else "cpu"
    generator = torch.Generator(device=generator_device).manual_seed(777)
    with infer_lock, torch.inference_mode():
        output = pipeline(
            image=image,
            generator=generator,
            true_cfg_scale=4.0,
            negative_prompt=" ",
            num_inference_steps=steps,
            num_images_per_prompt=1,
            layers=layers,
            resolution=resolution,
            cfg_normalize=True,
            use_en_prompt=True,
            callback_on_step_end=update_progress,
        )

    inference_progress = 100
    generated = output.images[0]
    prepared = prepare_output_layers(image, generated, mode)
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return prepared, resolution, steps


@app.get("/health")
def health():
    return jsonify(service_info())


@app.get("/ready")
def ready():
    info = service_info()
    return jsonify(info), 200 if info["ready"] else 503


@app.post("/prepare")
def prepare():
    start_model_loader()
    return jsonify(service_info()), 202


@app.post("/decompose")
def decompose():
    image = image_from_request()
    mode = request.form.get("mode", "faithful")
    quality = request.form.get("quality", "fast")
    if mode not in {"faithful", "complete"}:
        raise ApiError("拆图模式不正确。")
    if quality not in {"fast", "high"}:
        raise ApiError("质量档位不正确。")

    layers = resolve_layer_count(image)
    prepared, resolution, steps = run_decomposition(image, mode, layers, quality)
    return jsonify(
        width=image.width,
        height=image.height,
        layer_count=len(prepared),
        requested_layers=layers,
        mode=mode,
        quality=quality,
        resolution=resolution,
        steps=steps,
        layers=[
            {
                "id": f"layer-{index + 1}",
                "name": f"图层 {index + 1}",
                "image": png_data_url(layer),
            }
            for index, layer in enumerate(prepared)
        ],
    )


if __name__ == "__main__":
    print(f"UI layer service: http://{HOST}:{PORT}")
    print("Open the website, connect to this service, then prepare the local model.")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
