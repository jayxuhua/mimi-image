# 咪咪Image创意工作台

一个轻量的 AI 生图 Web 工作台，基于 `gpt-image-2` 和 `tokenstation.top` 中转接口。项目不需要登录系统，用户在浏览器里填写自己的 API Key 后即可使用。

## 功能

- 文生图：输入 Prompt 后生成图片。
- 参考图改图：上传参考图后自动走 `/v1/images/edits`，适合基于原图做修改、重设计、换风格。
- 多图生成：单次最多生成 3 张，前端会连续请求并合并展示。
- 输出格式：支持 PNG / JPEG / WEBP。
- 前端压缩：选择 JPEG / WEBP 后，压缩级别会在浏览器端重新编码图片，实际影响最终文件体积。
- 本地历史：生成记录和图片 Blob 保存在浏览器 IndexedDB。
- 参考图限制：最多 2 张，单张不超过 3MB。
- 图片预览和下载：点击图片可放大预览，支持下载。

## 接口说明

前端请求本地代理：

- `openai-image.php`：转发生图请求到 `tokenstation.top`
- `upload.php`：上传参考图到本机 `uploads/`

无参考图时：

```text
POST https://tokenstation.top/v1/images/generations
```

有参考图时：

```text
POST https://tokenstation.top/v1/images/edits
```

参考图会被前端读成 base64 data URL，并以如下格式发送：

```json
{
  "model": "gpt-image-2",
  "prompt": "基于参考图重新设计...",
  "images": [
    { "image_url": "data:image/png;base64,..." }
  ]
}
```

## 本地运行

本机没有 PHP 时，可以用内置 Node 预览服务：

```bash
node dev-server.mjs
```

访问：

```text
http://localhost:8787
```

这个本地服务会模拟：

- 静态文件服务
- `/upload.php`
- `/openai-image.php`

## 服务器部署

推荐使用 Caddy + PHP-FPM。

```caddyfile
image.tokenstation.top {
    root * /var/www/mimi-image
    encode gzip zstd

    request_body {
        max_size 4MB
    }

    php_fastcgi unix//run/php/php8.2-fpm.sock
    file_server
}
```

部署目录示例：

```bash
cd /var/www
git clone https://github.com/jayxuhua/mimi-image.git mimi-image
cd /var/www/mimi-image
mkdir -p uploads
chown -R www-data:www-data uploads
chmod -R 755 uploads
```

服务器需要：

- PHP 7.4+ / PHP 8.x
- PHP `curl`
- PHP `fileinfo`
- `uploads/` 目录可写
- 服务器能访问 `https://tokenstation.top`

## Cloudflare

如果使用子域名，例如：

```text
image.tokenstation.top
```

在 Cloudflare 添加 DNS：

```text
Type: A
Name: image
Content: 服务器 IP
```

建议先设为 DNS only 测通，再按需开启橙云代理。

## 注意

- API Key 保存在用户浏览器 IndexedDB，不写入服务器数据库。
- 当前版本没有登录、积分、支付系统。
- PNG 文件通常较大；如果需要更小体积，建议输出 WEBP 或 JPEG，并降低压缩级别。
- 参考图改图依赖中转站 `/v1/images/edits` 能力。

## License

MIT
