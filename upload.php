<?php
/**
 * 参考图上传：保存到 uploads 目录，返回公网可访问 URL（JSON）。
 * 安全策略：仅 POST、5MB 上限、白名单 MIME + 魔数校验、随机文件名。
 *
 * @author EllisFan<ellisfan07@gmail.com>
 * @date 2026-05-10
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => '仅支持 POST'], JSON_UNESCAPED_UNICODE);
    exit;
}

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
];

/**
 * @return never
 */
function json_fail(string $msg, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
    json_fail('未收到文件');
}

$f = $_FILES['file'];
$err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);

if ($err !== UPLOAD_ERR_OK) {
    if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
        json_fail('文件超过大小限制', 413);
    }
    json_fail('上传失败');
}

$size = (int) ($f['size'] ?? 0);
if ($size <= 0 || $size > MAX_BYTES) {
    json_fail('文件大小须大于 0 且不超过 5MB');
}

$tmp = (string) ($f['tmp_name'] ?? '');
if ($tmp === '' || !is_uploaded_file($tmp)) {
    json_fail('非法上传');
}

if (!class_exists('finfo')) {
    json_fail('服务器未启用 fileinfo 扩展', 500);
}

$finfo = new finfo(FILEINFO_MIME_TYPE);
$mimeRaw = $finfo->file($tmp);
if ($mimeRaw === false) {
    json_fail('无法检测文件类型');
}

$mime = strtolower(trim(explode(';', $mimeRaw)[0]));
if (!isset(ALLOWED_MIME[$mime])) {
    json_fail('仅支持 JPG、JPEG、PNG 图片');
}

$head = @file_get_contents($tmp, false, null, 0, 12);
if ($head === false || strlen($head) < 8) {
    json_fail('无法读取文件内容');
}

$magicOk = false;
if ($mime === 'image/jpeg' && strncmp($head, "\xFF\xD8\xFF", 3) === 0) {
    $magicOk = true;
}
if ($mime === 'image/png' && strncmp($head, "\x89PNG\r\n\x1a\n", 8) === 0) {
    $magicOk = true;
}
if (!$magicOk) {
    json_fail('文件内容与类型不符');
}

$ext = ALLOWED_MIME[$mime];

$rand = '';
$alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
try {
    for ($i = 0; $i < 6; $i++) {
        $rand .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
} catch (Exception $e) {
    json_fail('随机数生成失败', 500);
}

$datePath = date('Y/m/d');
$basename = time() . '_' . $rand . '.' . $ext;

$uploadRoot = __DIR__ . DIRECTORY_SEPARATOR . 'uploads';
$destDir = $uploadRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $datePath);
$destPath = $destDir . DIRECTORY_SEPARATOR . $basename;

if (!is_dir($destDir)) {
    if (!@mkdir($destDir, 0755, true)) {
        json_fail('无法创建存储目录', 500);
    }
}

if (!@move_uploaded_file($tmp, $destPath)) {
    json_fail('保存文件失败', 500);
}

@chmod($destPath, 0644);

$scheme = 'http';
if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
    $scheme = 'https';
} elseif (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
    $forwarded = strtolower(trim(explode(',', $_SERVER['HTTP_X_FORWARDED_PROTO'])[0]));
    $scheme = $forwarded === 'https' ? 'https' : 'http';
}

$host = $_SERVER['HTTP_HOST'] ?? 'localhost';
$scriptName = $_SERVER['SCRIPT_NAME'] ?? '/upload.php';
$basePath = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');
$webPath = ($basePath === '' ? '' : $basePath) . '/uploads/' . $datePath . '/' . $basename;

$publicUrl = $scheme . '://' . $host . $webPath;

echo json_encode(['ok' => true, 'url' => $publicUrl], JSON_UNESCAPED_UNICODE);
