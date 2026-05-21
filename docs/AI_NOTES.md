# AI Agent Notes

- The UI intentionally hides the legacy generation quality selector and pixel-size selector. Keep the code paths because they may be reused later.
- The output format selector is visible again and supports PNG / JPEG / WEBP. `output_compression` is sent only for JPEG and WEBP async tasks; PNG hides the compression slider.
- The visible `1K / 2K / 4K` control maps to official `size` and `quality` parameters for `gpt-image-2`. Cost depends on both fields, so do not leave 1K on hidden high quality.
  - `1K` -> long edge around `1024px`
  - `2K` -> long edge around `2048px`
  - `4K` -> long edge up to `3840px`, constrained by max pixels and aspect ratio rules
- Hidden quality mapping:
  - `1K` -> `quality: "low"`
  - `2K` -> `quality: "medium"`
  - `4K` -> `quality: "high"`
- Aspect ratio selection remains visible. The app still maps ratios to OpenAI-supported pixel sizes before submission.
