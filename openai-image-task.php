<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');

function json_fail(string $msg, int $code = 400): void {
    http_response_code($code);
    echo json_encode(['error' => ['message' => $msg]], JSON_UNESCAPED_UNICODE);
    exit;
}

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!preg_match('/^Bearer\s+.+/i', $auth)) {
    json_fail('missing bearer token', 401);
}

$base = 'https://tokenstation.top/v1/images/tasks';
$method = $_SERVER['REQUEST_METHOD'];
$endpoint = $base;

if ($method === 'GET') {
    $id = trim((string)($_GET['id'] ?? ''));
    if ($id === '') json_fail('missing task id', 400);
    $endpoint = $base . '/' . rawurlencode($id);
} elseif ($method === 'POST') {
    if (($_GET['mode'] ?? '') === 'edit') {
        $endpoint .= '?mode=edit';
    }
} else {
    json_fail('method not allowed', 405);
}

$headers = ['Authorization: ' . $auth];
if ($method === 'POST') $headers[] = 'Content-Type: application/json';

$ch = curl_init($endpoint);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT        => 60,
]);

if ($method === 'POST') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input') ?: '{}');
}

$resp = curl_exec($ch);
$err = curl_error($ch);
$code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($resp === false) json_fail('task proxy curl error: ' . $err, 502);

http_response_code($code ?: 200);
echo $resp;
