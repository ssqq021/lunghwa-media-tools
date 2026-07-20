import unittest

from PIL import Image

from ui_layer_core import (
    choose_auto_layer_count,
    clamp_layer_count,
    prepare_output_layers,
)


class UiLayerCoreTests(unittest.TestCase):
    def test_clamps_manual_layer_count(self):
        self.assertEqual(clamp_layer_count(1), 3)
        self.assertEqual(clamp_layer_count(6), 6)
        self.assertEqual(clamp_layer_count(20), 8)

    def test_auto_layer_count_stays_in_supported_range(self):
        simple = Image.new("RGB", (720, 1440), "black")
        detailed = Image.new("RGB", (256, 256))
        detailed.putdata(
            [
                (245, 245, 245) if ((x // 4) + (y // 4)) % 2 else (10, 10, 10)
                for y in range(detailed.height)
                for x in range(detailed.width)
            ]
        )

        self.assertGreaterEqual(choose_auto_layer_count(simple), 3)
        self.assertLessEqual(choose_auto_layer_count(detailed), 8)
        self.assertGreater(choose_auto_layer_count(detailed), choose_auto_layer_count(simple))

    def test_faithful_mode_preserves_source_rgb_and_generated_alpha(self):
        source = Image.new("RGB", (2, 1), (10, 20, 30))
        generated = Image.new("RGBA", (2, 1), (200, 150, 100, 128))

        output = prepare_output_layers(source, [generated], "faithful")[0]

        self.assertEqual(output.getpixel((0, 0))[:3], (10, 20, 30))
        self.assertEqual(output.getpixel((0, 0))[3], 128)

    def test_completion_mode_keeps_generated_pixels_and_restores_source_size(self):
        source = Image.new("RGB", (4, 2), "black")
        generated = Image.new("RGBA", (2, 1), (200, 150, 100, 255))

        output = prepare_output_layers(source, [generated], "complete")[0]

        self.assertEqual(output.size, source.size)
        self.assertEqual(output.getpixel((1, 1)), (200, 150, 100, 255))


if __name__ == "__main__":
    unittest.main()
