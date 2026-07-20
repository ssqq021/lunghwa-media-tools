import base64
import io
import math
from typing import Iterable

import numpy as np
from PIL import Image, ImageFilter


MIN_LAYERS = 3
MAX_LAYERS = 8


def clamp_layer_count(value):
    try:
        count = int(value)
    except (TypeError, ValueError):
        raise ValueError("图层数量必须是 3 到 8 之间的整数。") from None
    return min(MAX_LAYERS, max(MIN_LAYERS, count))


def choose_auto_layer_count(image):
    preview = image.convert("RGB")
    preview.thumbnail((256, 256), Image.Resampling.LANCZOS)
    pixels = np.asarray(preview, dtype=np.int16)
    if pixels.size == 0:
        return 4

    gray = pixels.mean(axis=2)
    horizontal = np.abs(np.diff(gray, axis=1))
    vertical = np.abs(np.diff(gray, axis=0))
    edge_density = float(
        (np.count_nonzero(horizontal > 20) + np.count_nonzero(vertical > 20))
        / max(1, horizontal.size + vertical.size)
    )
    quantized = (pixels // 32).astype(np.uint8)
    color_count = len(np.unique(quantized.reshape(-1, 3), axis=0))
    megapixels = image.width * image.height / 1_000_000

    complexity = edge_density * 18 + math.log2(max(2, color_count)) / 4 + megapixels / 3
    return clamp_layer_count(round(3 + complexity))


def prepare_output_layers(source, generated_layers: Iterable[Image.Image], mode):
    source_rgba = source.convert("RGBA")
    output = []

    for generated in generated_layers:
        layer = generated.convert("RGBA").resize(source_rgba.size, Image.Resampling.LANCZOS)
        if mode == "faithful":
            alpha = layer.getchannel("A").filter(ImageFilter.GaussianBlur(radius=0.35))
            faithful = source_rgba.copy()
            faithful.putalpha(alpha)
            output.append(faithful)
        else:
            output.append(layer)

    return output


def png_data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"
