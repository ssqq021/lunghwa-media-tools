import base64
import io
import unittest

from PIL import Image

import server


class FakeOutput:
    def __init__(self, images):
        self.images = [images]


class FakePipeline:
    def __call__(self, **kwargs):
        layers = kwargs["layers"]
        image = kwargs["image"]
        generated = [
            Image.new("RGBA", image.size, (200, 100 + index, 50, 128))
            for index in range(layers)
        ]
        callback = kwargs.get("callback_on_step_end")
        if callback:
            callback(self, 0, 0, {})
        return FakeOutput(generated)


def png_upload(color=(10, 20, 30)):
    buffer = io.BytesIO()
    Image.new("RGB", (4, 3), color).save(buffer, "PNG")
    buffer.seek(0)
    return buffer


class UiLayerServerTests(unittest.TestCase):
    def test_only_network_failures_are_retryable(self):
        self.assertTrue(server.is_retryable_download_error(RuntimeError("IncompleteRead")))
        self.assertFalse(server.is_retryable_download_error(RuntimeError("CUDA out of memory")))

    def setUp(self):
        self.original_pipeline = server.pipeline
        self.original_status = server.model_status
        server.pipeline = FakePipeline()
        server.model_status = "ready"
        server.app.config["TESTING"] = True
        self.client = server.app.test_client()

    def tearDown(self):
        server.pipeline = self.original_pipeline
        server.model_status = self.original_status

    def test_health_reports_local_service(self):
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ready"])
        self.assertEqual(response.get_json()["model"], "Qwen/Qwen-Image-Layered")

    def test_rejects_unapproved_web_origins(self):
        response = self.client.get("/health", headers={"Origin": "https://example.com"})

        self.assertEqual(response.status_code, 403)

    def test_decomposes_into_requested_faithful_layers(self):
        response = self.client.post(
            "/decompose",
            data={
                "file": (png_upload(), "ui.png"),
                "layers": "3",
                "mode": "faithful",
                "quality": "fast",
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["layer_count"], 3)
        encoded = payload["layers"][0]["image"].split(",", 1)[1]
        layer = Image.open(io.BytesIO(base64.b64decode(encoded)))
        self.assertEqual(layer.getpixel((0, 0))[:3], (10, 20, 30))
        self.assertEqual(layer.getpixel((0, 0))[3], 128)

    def test_validates_layer_count(self):
        response = self.client.post(
            "/decompose",
            data={
                "file": (png_upload(), "ui.png"),
                "layers": "many",
                "mode": "complete",
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
