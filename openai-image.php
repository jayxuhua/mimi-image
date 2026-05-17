<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => ['message' => 'Only POST is supported']], JSON_UNESCAPED_UNICODE);
    exit;
}

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!preg_match('/^Bearer\s+(.+)$/i', $auth, $m) || trim($m[1]) === '') {
    http_response_code(401);
    echo json_encode(['error' => ['message' => 'Missing OpenAI API Key']], JSON_UNESCAPED_UNICODE);
    exit;
}

$raw = file_get_contents('php://input');
if ($raw === false || trim($raw) === '') {
    http_response_code(400);
    echo json_encode(['error' => ['message' => 'Empty request body']], JSON_UNESCAPED_UNICODE);
    exit;
}

$payload = json_decode($raw, true);
if (!is_array($payload)) {
    http_response_code(400);
    echo json_encode(['error' => ['message' => 'Invalid JSON body']], JSON_UNESCAPED_UNICODE);
    exit;
}

$allowed = [
    'model',
    'prompt',
    'size',
    'quality',
    'output_format',
    'output_compression',
    'n',
    'images',
    'mask',
    'input_fidelity',
];
$body = [];
foreach ($allowed as $key) {
    if (array_key_exists($key, $payload)) {
        $body[$key] = $payload[$key];
    }
}

$jsonBody = json_encode($body, JSON_UNESCAPED_UNICODE);
if ($jsonBody === false) {
    http_response_code(400);
    echo json_encode(['error' => ['message' => 'Unable to encode request body']], JSON_UNESCAPED_UNICODE);
    exit;
}

$mode = strtolower((string) ($_GET['mode'] ?? ''));
$endpoint = $mode === 'edit'
    ? 'https://tokenstation.top/v1/images/edits'
    : 'https://tokenstation.top/v1/images/generations';

$ch = curl_init($endpoint);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . trim($m[1]),
    ],
    CURLOPT_POSTFIELDS => $jsonBody,
    CURLOPT_CONNECTTIMEOUT => 20,
    CURLOPT_TIMEOUT => 300,
]);

$response = curl_exec($ch);
$errno = curl_errno($ch);
$error = curl_error($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false || $errno !== 0) {
    http_response_code(502);
    echo json_encode(['error' => ['message' => 'OpenAI request failed: ' . $error]], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code($status > 0 ? $status : 502);
echo $response;
