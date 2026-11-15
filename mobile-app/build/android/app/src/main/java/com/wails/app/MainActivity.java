package com.wails.app;

import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * MainActivity hosts the WebView and manages the Wails application lifecycle.
 * It uses WebViewAssetLoader to serve assets from the Go library without
 * requiring a network server.
 */
public class MainActivity extends AppCompatActivity {
    private static final String TAG = "WailsActivity";
    private static final boolean DEBUG = BuildConfig.DEBUG;
    private static final String WAILS_SCHEME = "https";
    private static final String WAILS_HOST = "wails.localhost";
    private static final int FILE_PICKER_REQUEST = 7001;

    private WebView webView;
    private WailsBridge bridge;
    // Battery: system-event receivers are registered only while the activity is
    // in the foreground (onStart) and torn down in onStop, so background battery/
    // network/screen broadcasts don't wake the app.
    private boolean systemReceiversRegistered = false;
    private WebViewAssetLoader assetLoader;

    // The Go-side dialog ID of the in-flight file picker (-1 when idle)
    private int pendingFilePickerCallbackID = -1;
    private static final int PHOTO_CAPTURE_REQUEST = 7002;
    private static final int VIDEO_CAPTURE_REQUEST = 7003;
    private static final int CAMERA_PERMISSION_REQUEST = 7010;

    // In-flight callback for an HTML <input type="file"> chooser opened by the
    // WebView's WebChromeClient (null when idle).
    private static final int WEBVIEW_FILE_CHOOSER_REQUEST = 7004;
    private ValueCallback<Uri[]> webViewFileChooserCallback;
    private File pendingCaptureFile;
    private boolean pendingCaptureIsVideo;

    // System-event sources (battery/power, screen lock, network). Registered in
    // onCreate, torn down in onDestroy. Each forwards a "system:*" event to JS
    // via the bridge.
    private BroadcastReceiver batteryReceiver;
    private BroadcastReceiver screenReceiver;
    private BroadcastReceiver powerSaveReceiver;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        applySystemInsets();

        // Initialize the native Go library
        bridge = new WailsBridge(this);
        bridge.initialize();

        // Set up WebView
        setupWebView();

        // Load the application
        loadApplication();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        webView = findViewById(R.id.webview);
        bridge.setWebView(webView);

        // Configure WebView settings
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // The remote DSH UI is a desktop-class SPA: give it a real viewport.
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);

        // DSH authenticates with cookies (relay gate + DSH session); keep them
        // across launches so the phone stays signed in.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        // Enable debugging in debug builds
        if (DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Set up asset loader for serving local assets
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(WAILS_HOST)
                .addPathHandler("/", new WailsPathHandler(bridge))
                .build();

        // Set up WebView client to intercept requests
        webView.setWebViewClient(new WebViewClient() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Handle wails.localhost requests
                if (request.getUrl().getHost() != null &&
                        request.getUrl().getHost().equals(WAILS_HOST)) {

                    // For wails API calls (runtime, capabilities, etc.) pass the
                    // full URL including the query string, because
                    // WebViewAssetLoader.PathHandler strips query params
                    String path = request.getUrl().getPath();
                    if (path != null && path.startsWith("/wails/")) {
                        String fullPath = path;
                        String query = request.getUrl().getQuery();
                        if (query != null && !query.isEmpty()) {
                            fullPath = path + "?" + query;
                        }
                        if (DEBUG) Log.d(TAG, "Wails API call: " + fullPath);

                        byte[] data = bridge.serveAsset(fullPath, request.getMethod(), "{}");
                        if (data != null && data.length > 0) {
                            java.io.InputStream inputStream = new java.io.ByteArrayInputStream(data);
                            java.util.Map<String, String> headers = new java.util.HashMap<>();
                            headers.put("Access-Control-Allow-Origin", "*");
                            headers.put("Cache-Control", "no-cache");
                            headers.put("Content-Type", "application/json");

                            // Detect error envelopes: if the body starts with
                            // {"ok":false, return HTTP 500 so the fallback
                            // transport's fetch() rejects the promise.
                            int status = 200;
                            String reason = "OK";
                            if (data.length > 12) {
                                String prefix = new String(data, 0, Math.min(data.length, 20),
                                        java.nio.charset.StandardCharsets.UTF_8);
                                if (prefix.contains("\"ok\":false")) {
                                    status = 500;
                                    reason = "Internal Error";
                                }
                            }

                            return new WebResourceResponse(
                                "application/json",
                                "UTF-8",
                                status,
                                reason,
                                headers,
                                inputStream
                            );
                        }
                        // Return error response if data is null
                        return new WebResourceResponse(
                            "application/json",
                            "UTF-8",
                            500,
                            "Internal Error",
                            new java.util.HashMap<>(),
                            new java.io.ByteArrayInputStream("{}".getBytes())
                        );
                    }

                    // Stream captured photos/videos from the cache with HTTP Range
                    // support so <video> can seek/stream a clip of any length.
                    if (path != null && path.startsWith("/__capture__/")) {
                        return serveCaptureFile(path.substring("/__capture__/".length()), request);
                    }

                    // For regular assets, use the asset loader
                    return assetLoader.shouldInterceptRequest(request.getUrl());
                }

                return super.shouldInterceptRequest(view, request);
            }

            /**
             * Keep the bundled settings page and the DSH server the user logged
             * into inside the WebView; open every other link in the system browser.
             */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                String scheme = uri.getScheme();
                if (host == null || WAILS_HOST.equals(host)) return false;
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    openExternally(uri);
                    return true;
                }
                if (remoteHost == null || host.equalsIgnoreCase(remoteHost)) {
                    // The first remote navigation (the login POST) pins the host.
                    remoteHost = host;
                    return false;
                }
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                Uri uri = Uri.parse(url);
                if (uri.getHost() != null && !WAILS_HOST.equals(uri.getHost()) && remoteHost == null) {
                    remoteHost = uri.getHost();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (!request.isForMainFrame() || request.getUrl().getHost() == null
                        || WAILS_HOST.equals(request.getUrl().getHost())) return;
                int code = error.getErrorCode();
                Log.w(TAG, "main-frame error " + code + " " + error.getDescription() + " for " + request.getUrl());
                // Only real reachability failures mean the tunnel is down; an
                // aborted/replaced navigation (ERROR_UNKNOWN, e.g. net::ERR_ABORTED
                // while the SPA redirects) must not kick the user out.
                switch (code) {
                    case WebViewClient.ERROR_HOST_LOOKUP:
                    case WebViewClient.ERROR_CONNECT:
                    case WebViewClient.ERROR_TIMEOUT:
                    case WebViewClient.ERROR_FAILED_SSL_HANDSHAKE:
                    case WebViewClient.ERROR_PROXY_AUTHENTICATION:
                        returnToSettings("offline");
                        break;
                    default:
                        break;
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                if (DEBUG) Log.d(TAG, "Page loaded: " + url);
                bridge.onPageFinished(url);
                Uri page = Uri.parse(url);
                if (page.getHost() != null && !WAILS_HOST.equals(page.getHost())) {
                    view.evaluateJavascript(BLOB_DOWNLOAD_SHIM, null);
                }
                syncBarsWithPage(view);
                // Now that JS listeners are mounted, push a snapshot of the
                // current battery / network / theme so the UI starts populated.
                emitSystemSnapshot();
            }
        });

        // Add JavaScript interface for Go communication
        webView.addJavascriptInterface(new WailsJSBridge(bridge, webView), "wails");

        // Downloads started by the remote DSH page: blob: object URLs are read
        // in-page and streamed to the DshDownloads bridge; http(s) URLs (e.g.
        // /peer-link/zip) are fetched natively with the page's cookies.
        webView.addJavascriptInterface(new DownloadBridge(), "DshDownloads");
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url == null) return;
            if (url.startsWith("blob:")) {
                String name = contentDisposition != null && !contentDisposition.isEmpty()
                        ? URLUtil.guessFileName(url, contentDisposition, mimetype) : "";
                webView.evaluateJavascript(BLOB_DOWNLOAD_SHIM + ";window.__DSH_SAVE_BLOB__&&window.__DSH_SAVE_BLOB__("
                        + JSONObject.quote(url) + "," + JSONObject.quote(name) + ")", null);
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
                downloadHttp(url, userAgent, contentDisposition, mimetype);
            } else {
                showToast("下载失败：不支持的链接");
            }
        });

        // A WebChromeClient is required for HTML <input type="file"> elements to
        // work; without onShowFileChooser the WebView silently ignores clicks on
        // file inputs. It also forwards JS console messages to logcat for
        // debugging. Note: in-page permission prompts (geolocation, getUserMedia)
        // require an onPermissionRequest override which is not provided here;
        // those requests will be denied by the default implementation until a
        // scoped permissions handler is added.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                if (DEBUG) {
                    Log.d(TAG, "[WebView] " + msg.messageLevel() + ": " + msg.message()
                            + " (" + msg.sourceId() + ":" + msg.lineNumber() + ")");
                }
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                // Cancel any previous, still-pending chooser before starting a new one.
                if (webViewFileChooserCallback != null) {
                    webViewFileChooserCallback.onReceiveValue(null);
                }
                webViewFileChooserCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, WEBVIEW_FILE_CHOOSER_REQUEST);
                } catch (android.content.ActivityNotFoundException e) {
                    webViewFileChooserCallback = null;
                    filePathCallback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
    }

    private void loadApplication() {
        String url = WAILS_SCHEME + "://" + WAILS_HOST + "/";
        if (DEBUG) Log.d(TAG, "Loading URL: " + url);
        webView.loadUrl(url);
    }

    /**
     * Launch the system camera to capture a photo (video=false) or a video
     * (video=true). The capture is written to a FileProvider URI in the cache and
     * the result is delivered to JS as a "common:capture" event.
     */
    public void launchCameraCapture(boolean video) {
        if (checkSelfPermission("android.permission.CAMERA") != PackageManager.PERMISSION_GRANTED) {
            pendingCaptureIsVideo = video;
            requestPermissions(new String[]{"android.permission.CAMERA"}, CAMERA_PERMISSION_REQUEST);
            return;
        }
        try {
            File dir = new File(getCacheDir(), "captures");
            if (!dir.exists()) dir.mkdirs();
            pendingCaptureFile = new File(dir, "capture_" + System.currentTimeMillis() + (video ? ".mp4" : ".jpg"));
            pendingCaptureIsVideo = video;
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", pendingCaptureFile);
            Intent intent = new Intent(video ? MediaStore.ACTION_VIDEO_CAPTURE : MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            // Don't pre-check with resolveActivity(): Android 11+ package visibility
            // hides other apps' intents unless declared in <queries>, so it can
            // return null even when a camera app exists. Just launch and handle a miss.
            startActivityForResult(intent, video ? VIDEO_CAPTURE_REQUEST : PHOTO_CAPTURE_REQUEST);
        } catch (android.content.ActivityNotFoundException e) {
            bridge.emitEvent("common:capture", "{\"error\":\"no camera app available\"}");
        } catch (Exception e) {
            Log.e(TAG, "launchCameraCapture failed", e);
            bridge.emitEvent("common:capture", "{\"error\":\"capture failed\"}");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                launchCameraCapture(pendingCaptureIsVideo);
            } else {
                bridge.emitEvent("common:capture", "{\"error\":\"camera permission denied\"}");
            }
            return;
        }
        if (bridge != null) {
            bridge.onRequestPermissionsResult(requestCode, grantResults);
        }
    }

    private void handleCaptureResult(int resultCode, @Nullable Intent data) {
        File file = pendingCaptureFile;
        final boolean video = pendingCaptureIsVideo;
        pendingCaptureFile = null;
        if (resultCode != RESULT_OK) {
            bridge.emitEvent("common:capture", "{\"cancelled\":true}");
            return;
        }
        // Some camera apps (commonly for video) ignore EXTRA_OUTPUT and instead
        // return a content URI in the result data; copy that into our cache.
        if ((file == null || !file.exists() || file.length() == 0)
                && data != null && data.getData() != null) {
            String copied = copyUriToCache(data.getData());
            if (copied != null) file = new File(copied);
        }
        final File f = file;
        if (f == null || !f.exists() || f.length() == 0) {
            bridge.emitEvent("common:capture", "{\"cancelled\":true}");
            return;
        }
        new Thread(() -> {
            try {
                JSONObject o = new JSONObject();
                o.put("type", video ? "video" : "photo");
                o.put("path", f.getAbsolutePath());
                o.put("size", f.length());
                if (!video) {
                    String thumb = makePhotoThumbnail(f);
                    if (thumb != null) o.put("thumb", thumb);
                }
                // Stream URL works for both: <video>/<img> load it from the cache
                // via shouldInterceptRequest (Range-enabled), no size limit.
                o.put("streamUrl", captureStreamUrl(f));
                bridge.emitEvent("common:capture", o.toString());
            } catch (Exception e) {
                Log.e(TAG, "handleCaptureResult failed", e);
                bridge.emitEvent("common:capture", "{\"error\":\"result processing failed\"}");
            }
        }).start();
    }

    /** Downscale a captured photo into a base64 JPEG data URL for display in the webview. */
    @Nullable
    private String makePhotoThumbnail(File file) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sample > 640) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
            if (bmp == null) return null;
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 70, baos);
            bmp.recycle();
            return "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Build a same-origin URL the webview can stream a capture from. Served by
     * serveCaptureFile (via shouldInterceptRequest); the path is relative to the
     * cache dir so both camera files (captures/) and copied content URIs
     * (wails-picker/) resolve.
     */
    private String captureStreamUrl(File file) {
        String base = getCacheDir().getAbsolutePath() + File.separator;
        String abs = file.getAbsolutePath();
        String rel = abs.startsWith(base) ? abs.substring(base.length()) : file.getName();
        return "/__capture__/" + Uri.encode(rel, "/");
    }

    /**
     * Serve a captured file (under the app cache) to the webview with HTTP Range
     * support, so &lt;video&gt; can stream and seek a clip of any length without
     * inlining it as a data URL.
     */
    private WebResourceResponse serveCaptureFile(String relPath, WebResourceRequest request) {
        try {
            File cache = getCacheDir();
            File file = new File(cache, Uri.decode(relPath));
            // Path-traversal guard: only ever serve files under the cache dir.
            if (!file.getCanonicalPath().startsWith(cache.getCanonicalPath() + File.separator)
                    || !file.exists() || !file.isFile()) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                        new java.util.HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
            }
            String name = file.getName().toLowerCase();
            String mime = name.endsWith(".mp4") ? "video/mp4"
                    : name.endsWith(".mov") ? "video/quicktime"
                    : name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg"
                    : name.endsWith(".png") ? "image/png" : "application/octet-stream";
            long length = file.length();
            java.util.Map<String, String> reqHeaders = request.getRequestHeaders();
            String range = reqHeaders != null ? reqHeaders.get("Range") : null;
            if (range == null && reqHeaders != null) range = reqHeaders.get("range");

            java.util.Map<String, String> headers = new java.util.HashMap<>();
            headers.put("Accept-Ranges", "bytes");
            headers.put("Cache-Control", "no-store");

            if (range != null && range.startsWith("bytes=")) {
                long start = 0, end = length - 1;
                String spec = range.substring(6).trim();
                int dash = spec.indexOf('-');
                if (dash >= 0) {
                    try {
                        if (dash > 0) start = Long.parseLong(spec.substring(0, dash).trim());
                        String e = spec.substring(dash + 1).trim();
                        if (!e.isEmpty()) end = Long.parseLong(e);
                    } catch (NumberFormatException ignored) { }
                }
                if (start < 0) start = 0;
                if (end >= length) end = length - 1;
                if (start > end) { start = 0; end = length - 1; }
                long count = end - start + 1;
                java.io.InputStream in = new java.io.FileInputStream(file);
                long toSkip = start;
                while (toSkip > 0) {
                    long s = in.skip(toSkip);
                    if (s <= 0) break;
                    toSkip -= s;
                }
                headers.put("Content-Range", "bytes " + start + "-" + end + "/" + length);
                headers.put("Content-Length", String.valueOf(count));
                return new WebResourceResponse(mime, null, 206, "Partial Content",
                        headers, new LimitedInputStream(in, count));
            }
            headers.put("Content-Length", String.valueOf(length));
            return new WebResourceResponse(mime, null, 200, "OK", headers,
                    new java.io.FileInputStream(file));
        } catch (Exception e) {
            Log.e(TAG, "serveCaptureFile failed", e);
            return new WebResourceResponse("text/plain", "UTF-8", 500, "Error",
                    new java.util.HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    /** Wraps a stream to yield at most a fixed number of bytes (for Range responses). */
    private static final class LimitedInputStream extends java.io.FilterInputStream {
        private long remaining;
        LimitedInputStream(java.io.InputStream in, long limit) {
            super(in);
            this.remaining = limit;
        }
        @Override public int read() throws java.io.IOException {
            if (remaining <= 0) return -1;
            int b = super.read();
            if (b >= 0) remaining--;
            return b;
        }
        @Override public int read(byte[] b, int off, int len) throws java.io.IOException {
            if (remaining <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }
    }

    /**
     * Launch the system document picker. Results are copied into the app's
     * cache directory so Go receives real filesystem paths. Called by
     * WailsBridge on the main thread.
     */
    public void launchFilePicker(int callbackID, boolean multiple) {
        synchronized (this) {
            if (pendingFilePickerCallbackID != -1) {
                // Only one picker can be in flight
                bridge.filePickerDone(callbackID);
                return;
            }
            pendingFilePickerCallbackID = callbackID;
        }

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        try {
            startActivityForResult(intent, FILE_PICKER_REQUEST);
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch file picker", e);
            pendingFilePickerCallbackID = -1;
            bridge.filePickerDone(callbackID);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PHOTO_CAPTURE_REQUEST || requestCode == VIDEO_CAPTURE_REQUEST) {
            handleCaptureResult(resultCode, data);
            return;
        }
        if (requestCode == WEBVIEW_FILE_CHOOSER_REQUEST) {
            if (webViewFileChooserCallback == null) {
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    // Multiple selection (<input type="file" multiple>) is
                    // returned as ClipData. FileChooserParams.parseResult only
                    // reads getData(), so it would drop all but one (and return
                    // null when getData() is empty) — read every item explicitly.
                    int count = data.getClipData().getItemCount();
                    java.util.List<Uri> validated = new java.util.ArrayList<>(count);
                    for (int i = 0; i < count; i++) {
                        Uri uri = data.getClipData().getItemAt(i).getUri();
                        if (isFileChooserUriSafe(uri)) validated.add(uri);
                    }
                    if (!validated.isEmpty()) {
                        results = validated.toArray(new Uri[0]);
                    }
                } else if (data.getData() != null) {
                    Uri uri = data.getData();
                    if (isFileChooserUriSafe(uri)) {
                        results = new Uri[]{ uri };
                    }
                }
            }
            if (results == null) {
                // Fallback for pickers that report the result differently.
                results = FileChooserParams.parseResult(resultCode, data);
            }
            webViewFileChooserCallback.onReceiveValue(results);
            webViewFileChooserCallback = null;
            return;
        }
        if (requestCode != FILE_PICKER_REQUEST) {
            return;
        }
        final int callbackID = pendingFilePickerCallbackID;
        pendingFilePickerCallbackID = -1;
        if (callbackID == -1) {
            return;
        }

        final List<Uri> uris = new ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    uris.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }

        // Copy the documents off the main thread, then notify Go
        new Thread(() -> {
            for (Uri uri : uris) {
                String path = copyUriToCache(uri);
                if (path != null) {
                    bridge.filePickerResult(callbackID, path);
                }
            }
            bridge.filePickerDone(callbackID);
        }).start();
    }

    /**
     * Validate that a file-chooser URI is safe to pass to the WebView.
     * Rejects file:// URIs pointing at the app's own private data (a malicious
     * third-party picker could return such URIs to exfiltrate sensitive files).
     * Only content:// URIs (the standard document-picker output) are accepted.
     */
    private boolean isFileChooserUriSafe(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        // content:// URIs are the standard, safe output of document pickers.
        if ("content".equals(scheme)) return true;
        // Reject file:// URIs — they can point at app-private data.
        // Also reject anything else (null scheme, unknown schemes).
        if (DEBUG) Log.w(TAG, "Rejected unsafe file-chooser URI: " + uri);
        return false;
    }

    /**
     * Copy a content URI into the app cache and return its filesystem path.
     */
    @Nullable
    private String copyUriToCache(Uri uri) {
        String name = "document";
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && cursor.getString(idx) != null) {
                    name = new File(cursor.getString(idx)).getName();
                }
            }
        } catch (Exception ignored) {
        }

        try {
            File dir = new File(getCacheDir(), "wails-picker/" + System.nanoTime());
            if (!dir.mkdirs()) {
                return null;
            }
            File out = new File(dir, name);
            try (InputStream in = getContentResolver().openInputStream(uri);
                 OutputStream os = new FileOutputStream(out)) {
                if (in == null) {
                    return null;
                }
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                }
            }
            return out.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "Failed to copy picked document", e);
            return null;
        }
    }

    // ---- Downloads -------------------------------------------------------

    private static final long MAX_BLOB_DOWNLOAD = 200L * 1024 * 1024;
    private static final String DOWNLOAD_SUBDIR = "DSH Remote";

    /**
     * Injected into remote pages (idempotent). Exposes __DSH_SAVE_BLOB__(url, name)
     * which reads a blob: URL as base64 in chunks and streams it to the
     * DshDownloads bridge, and routes <a download href="blob:..."> clicks
     * (including detached anchors clicked from script) through it, since such
     * clicks don't reach the DownloadListener in every WebView version.
     */
    private static final String BLOB_DOWNLOAD_SHIM = "(function(){"
            + "if(window.__DSH_DL_SHIM__||location.hostname==='" + WAILS_HOST + "')return;"
            + "var B=window.DshDownloads;if(!B)return;window.__DSH_DL_SHIM__=1;"
            + "var MAX=" + MAX_BLOB_DOWNLOAD + ",CH=3*1024*1024;"
            + "function save(url,name){var id=null;"
            + "fetch(url).then(function(r){return r.blob();}).then(function(b){"
            + "if(b.size>MAX){B.fail('文件超过 200 MB，无法在应用内保存');return;}"
            + "id=B.begin(name||'',b.type||'');if(!id)return;var off=0;"
            + "(function next(){if(off>=b.size){B.finish(id);return;}"
            + "var fr=new FileReader();fr.onload=function(){var s=String(fr.result);"
            + "if(!B.chunk(id,s.substring(s.indexOf(',')+1)))return;off+=CH;next();};"
            + "fr.onerror=function(){B.abort(id,'读取文件失败');};"
            + "fr.readAsDataURL(b.slice(off,off+CH));})();"
            + "}).catch(function(e){if(id)B.abort(id,String(e&&e.message||e));"
            + "else B.fail('无法读取文件（'+String(e&&e.message||e)+'）');});}"
            + "window.__DSH_SAVE_BLOB__=save;"
            + "function take(a){var h=a&&a.href||'';if(!a.hasAttribute('download')||h.indexOf('blob:')!==0)return false;"
            + "save(h,a.getAttribute('download'));return true;}"
            + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[download]');"
            + "if(a&&take(a)){e.preventDefault();e.stopImmediatePropagation();}},true);"
            + "var oc=HTMLAnchorElement.prototype.click;"
            + "HTMLAnchorElement.prototype.click=function(){if(!this.isConnected&&take(this))return;return oc.apply(this,arguments);};"
            + "})()";

    /** JS bridge ("DshDownloads") receiving blob downloads as base64 chunks. */
    private final class DownloadBridge {
        private final java.util.Map<String, DownloadSink> sinks = new java.util.HashMap<>();
        private int nextId = 1;

        @JavascriptInterface
        public synchronized String begin(String name, String mime) {
            try {
                DownloadSink sink = openDownload(name, mime);
                String id = String.valueOf(nextId++);
                sinks.put(id, sink);
                return id;
            } catch (Exception e) {
                Log.e(TAG, "blob download open failed", e);
                showToast("下载失败：" + e.getMessage());
                return null;
            }
        }

        @JavascriptInterface
        public synchronized boolean chunk(String id, String base64) {
            DownloadSink sink = sinks.get(id);
            if (sink == null) return false;
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                if (sink.bytes + data.length > MAX_BLOB_DOWNLOAD) {
                    throw new java.io.IOException("文件超过 200 MB，无法在应用内保存");
                }
                sink.out.write(data);
                sink.bytes += data.length;
                return true;
            } catch (Exception e) {
                sinks.remove(id);
                sink.discard();
                Log.e(TAG, "blob download write failed", e);
                showToast("下载失败：" + e.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public synchronized void finish(String id) {
            DownloadSink sink = sinks.remove(id);
            if (sink == null) return;
            try {
                showToast("已保存到 " + sink.commit());
            } catch (Exception e) {
                sink.discard();
                Log.e(TAG, "blob download commit failed", e);
                showToast("下载失败：" + e.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized void abort(String id, String reason) {
            DownloadSink sink = sinks.remove(id);
            if (sink != null) sink.discard();
            fail(reason);
        }

        @JavascriptInterface
        public void fail(String reason) {
            showToast("下载失败：" + reason);
        }
    }

    /** Fetch an http(s) download natively, carrying the page's cookies. */
    private void downloadHttp(String url, String userAgent, String contentDisposition, String mimetype) {
        final String ua = userAgent != null ? userAgent : webView.getSettings().getUserAgentString();
        showToast("开始下载…");
        new Thread(() -> {
            HttpURLConnection conn = null;
            DownloadSink sink = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("User-Agent", ua);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new java.io.IOException("HTTP " + code);
                String cd = conn.getHeaderField("Content-Disposition");
                if (cd == null || cd.isEmpty()) cd = contentDisposition;
                String mime = conn.getContentType();
                if (mime == null || mime.isEmpty()) mime = mimetype;
                if (mime != null && mime.contains(";")) mime = mime.substring(0, mime.indexOf(';')).trim();
                String name = contentDispositionFileName(cd);
                if (name == null) name = URLUtil.guessFileName(url, cd, mime);
                sink = openDownload(name, mime);
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        sink.out.write(buf, 0, n);
                    }
                }
                showToast("已保存到 " + sink.commit());
            } catch (Exception e) {
                if (sink != null) sink.discard();
                Log.e(TAG, "http download failed", e);
                showToast("下载失败：" + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /** RFC 6266 filename*=UTF-8''... (URLUtil.guessFileName ignores it). */
    @Nullable
    private static String contentDispositionFileName(@Nullable String cd) {
        if (cd == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("filename\\*\\s*=\\s*([\\w-]+)''([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(cd);
        if (!m.find()) return null;
        try {
            return java.net.URLDecoder.decode(m.group(2).trim().replace("+", "%2B"), m.group(1));
        } catch (Exception e) {
            return null;
        }
    }

    /** An in-progress file in Downloads: MediaStore item (API 29+) or app-specific file. */
    private final class DownloadSink {
        final OutputStream out;
        final Uri uri;
        final File file;
        long bytes;

        DownloadSink(OutputStream out, @Nullable Uri uri, @Nullable File file) {
            this.out = out;
            this.uri = uri;
            this.file = file;
        }

        /** Publish the file; returns the user-facing location for the toast. */
        String commit() throws java.io.IOException {
            out.close();
            if (uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                String name = null;
                try (Cursor c = getContentResolver().query(uri,
                        new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst()) name = c.getString(0);
                }
                return "下载/" + DOWNLOAD_SUBDIR + "/" + name;
            }
            return file.getAbsolutePath();
        }

        void discard() {
            try {
                out.close();
            } catch (Exception ignored) {
            }
            try {
                if (uri != null) getContentResolver().delete(uri, null, null);
                if (file != null) file.delete();
            } catch (Exception ignored) {
            }
        }
    }

    private DownloadSink openDownload(@Nullable String rawName, @Nullable String mime) throws java.io.IOException {
        String name = rawName == null ? "" : new File(rawName.replace('\\', '/')).getName()
                .replaceAll("[\\x00-\\x1f:*?\"<>|]", "_").trim();
        if (name.isEmpty() || name.startsWith(".")) name = "download" + name;
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(name));
        if (name.lastIndexOf('.') <= 0) {
            String guessed = mime != null ? MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) : null;
            if (guessed != null) {
                name = name + "." + guessed;
                ext = guessed;
            }
        }
        // Prefer the type implied by the extension so MediaStore keeps the name as-is.
        String type = ext != null ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase()) : null;
        if (type == null) type = mime != null && !mime.isEmpty() ? mime : "application/octet-stream";

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, type);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new java.io.IOException("无法创建文件");
            OutputStream out = getContentResolver().openOutputStream(uri);
            if (out == null) {
                getContentResolver().delete(uri, null, null);
                throw new java.io.IOException("无法写入文件");
            }
            return new DownloadSink(out, uri, null);
        }

        // API < 29: app-specific Downloads dir, no storage permission needed.
        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new java.io.IOException("存储不可用");
        if (!dir.exists()) dir.mkdirs();
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String suffix = dot > 0 ? name.substring(dot) : "";
        File file = new File(dir, name);
        for (int i = 1; file.exists(); i++) {
            file = new File(dir, base + " (" + i + ")" + suffix);
        }
        return new DownloadSink(new FileOutputStream(file), null, file);
    }

    private void showToast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    /**
     * Execute JavaScript in the WebView from the Go side
     */
    public void executeJavaScript(final String js) {
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    // ---- System events ---------------------------------------------------
    // Battery/power, screen lock and network connectivity are surfaced to JS as
    // "system:*" events. The OS broadcasts used here (ACTION_BATTERY_CHANGED,
    // SCREEN_OFF, USER_PRESENT, POWER_SAVE_MODE_CHANGED) are protected system
    // broadcasts, so dynamic registration needs no RECEIVER_* export flag.

    private void registerSystemEventReceivers() {
        // Battery + charging state (sticky broadcast: the current value is
        // delivered to the receiver immediately on registration).
        batteryReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                emitBattery(intent);
            }
        };
        registerReceiver(batteryReceiver, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));

        // Low-power (battery saver) mode toggles → re-emit battery with the flag.
        powerSaveReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                emitBattery(registerSticky(Intent.ACTION_BATTERY_CHANGED));
            }
        };
        registerReceiver(powerSaveReceiver,
                new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED));

        // Screen lock / unlock. SCREEN_OFF ≈ locked; USER_PRESENT = unlocked.
        screenReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    emitLock(true);
                } else if (Intent.ACTION_USER_PRESENT.equals(action)) {
                    emitLock(false);
                }
            }
        };
        IntentFilter screenFilter = new IntentFilter();
        screenFilter.addAction(Intent.ACTION_SCREEN_OFF);
        screenFilter.addAction(Intent.ACTION_USER_PRESENT);
        registerReceiver(screenReceiver, screenFilter);

        // Network connectivity / transport type / cellular signal strength.
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager != null) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) { emitNetwork(network); }
                @Override public void onLost(Network network) { emitNetworkDisconnected(); }
                @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    emitNetwork(network);
                }
            };
            try {
                connectivityManager.registerDefaultNetworkCallback(networkCallback);
            } catch (Exception e) {
                Log.e(TAG, "registerDefaultNetworkCallback failed", e);
            }
        }
    }

    private void unregisterSystemEventReceivers() {
        safeUnregister(batteryReceiver);
        batteryReceiver = null;
        safeUnregister(powerSaveReceiver);
        powerSaveReceiver = null;
        safeUnregister(screenReceiver);
        screenReceiver = null;
        if (connectivityManager != null && networkCallback != null) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
            }
            networkCallback = null;
        }
    }

    private void safeUnregister(BroadcastReceiver r) {
        if (r != null) {
            try {
                unregisterReceiver(r);
            } catch (Exception ignored) {
            }
        }
    }

    /** Read the current sticky value for an action without a standing receiver. */
    @Nullable
    private Intent registerSticky(String action) {
        return registerReceiver(null, new IntentFilter(action));
    }

    /** Push current battery / network / theme so a freshly-loaded UI is populated. */
    private void emitSystemSnapshot() {
        emitBattery(registerSticky(Intent.ACTION_BATTERY_CHANGED));
        if (connectivityManager != null) {
            Network active = connectivityManager.getActiveNetwork();
            if (active != null) {
                emitNetwork(active);
            } else {
                emitNetworkDisconnected();
            }
        }
        emitTheme();
    }

    private void emitBattery(@Nullable Intent batteryStatus) {
        try {
            float level = -1f;
            String state = "unknown";
            if (batteryStatus != null) {
                int lvl = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (lvl >= 0 && scale > 0) {
                    level = lvl / (float) scale;
                }
                switch (batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
                    case BatteryManager.BATTERY_STATUS_CHARGING: state = "charging"; break;
                    case BatteryManager.BATTERY_STATUS_FULL: state = "full"; break;
                    case BatteryManager.BATTERY_STATUS_DISCHARGING:
                    case BatteryManager.BATTERY_STATUS_NOT_CHARGING: state = "unplugged"; break;
                    default: state = "unknown"; break;
                }
            }
            boolean lowPower = false;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                lowPower = pm.isPowerSaveMode();
            }
            JSONObject o = new JSONObject();
            o.put("level", (double) level);
            o.put("state", state);
            o.put("lowPowerMode", lowPower);
            if (bridge != null) bridge.emitSystemEvent("android:BatteryChanged", o.toString());
        } catch (Exception e) {
            Log.e(TAG, "emitBattery failed", e);
        }
    }

    private void emitNetwork(@Nullable Network network) {
        try {
            boolean connected = false;
            String type = "none";
            boolean metered = false;
            Integer signal = null;
            if (connectivityManager != null && network != null) {
                NetworkCapabilities caps = connectivityManager.getNetworkCapabilities(network);
                if (caps != null) {
                    connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                        type = "wifi";
                    } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                        type = "cellular";
                    } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                        type = "wired";
                    } else {
                        type = "other";
                    }
                    metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        int s = caps.getSignalStrength();
                        if (s != Integer.MIN_VALUE) {
                            signal = s; // dBm; closer to 0 is a stronger signal
                        }
                    }
                }
            }
            JSONObject o = new JSONObject();
            o.put("connected", connected);
            o.put("type", type);
            o.put("metered", metered);
            if (signal != null) {
                o.put("signal", (int) signal);
            }
            if (bridge != null) bridge.emitSystemEvent("android:NetworkChanged", o.toString());
        } catch (Exception e) {
            Log.e(TAG, "emitNetwork failed", e);
        }
    }

    private void emitNetworkDisconnected() {
        try {
            JSONObject o = new JSONObject();
            o.put("connected", false);
            o.put("type", "none");
            o.put("metered", false);
            if (bridge != null) bridge.emitSystemEvent("android:NetworkChanged", o.toString());
        } catch (Exception ignored) {
        }
    }

    private void emitLock(boolean locked) {
        // Lock/unlock are signals (no payload); name carries the state.
        if (bridge != null) {
            bridge.emitSystemEvent(locked ? "android:ScreenLocked" : "android:ScreenUnlocked", "{}");
        }
    }

    private void emitTheme() {
        try {
            int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            JSONObject o = new JSONObject();
            // "isDarkMode" matches the context key the desktop platforms use.
            o.put("isDarkMode", mode == Configuration.UI_MODE_NIGHT_YES);
            if (bridge != null) bridge.emitSystemEvent("android:ThemeChanged", o.toString());
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Fires for light/dark switches because the manifest lists uiMode in
        // android:configChanges (otherwise the activity would be recreated).
        emitTheme();
    }

    @Override
    protected void onStart() {
        super.onStart();
        // Battery: only monitor system events while the app is visible.
        if (!systemReceiversRegistered) {
            registerSystemEventReceivers();
            systemReceiversRegistered = true;
        }
        if (bridge != null) {
            bridge.onStart();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bridge != null) {
            bridge.onResume();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (bridge != null) {
            bridge.onPause();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (systemReceiversRegistered) {
            unregisterSystemEventReceivers();
            systemReceiversRegistered = false;
        }
        if (bridge != null) {
            bridge.onStop();
        }
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        if (bridge != null) {
            bridge.onLowMemory();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        unregisterSystemEventReceivers();
        if (bridge != null) {
            bridge.shutdown();
        }
        if (webView != null) {
            webView.destroy();
        }
    }

    /**
     * Android 15 forces edge-to-edge: the WebView would draw under the status
     * bar, gesture bar and keyboard. Pad the container by those insets instead
     * so the page (and its composer) always sits in the visible area.
     */
    private void applySystemInsets() {
        android.view.View container = findViewById(R.id.main_container);
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(container, (v, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.systemBars()
                    | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            androidx.core.graphics.Insets ime = insets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return androidx.core.view.WindowInsetsCompat.CONSUMED;
        });
    }

    /** Colour the bar areas like the page and pick readable status-bar icons. */
    private void syncBarsWithPage(WebView view) {
        view.evaluateJavascript(
                "(function(){var c=getComputedStyle(document.body).backgroundColor;"
                + "if(!c||c.indexOf('rgba(0, 0, 0, 0)')===0)c=getComputedStyle(document.documentElement).backgroundColor;"
                + "return c||'';})()",
                value -> {
                    int[] rgb = parseCssRgb(value);
                    if (rgb == null) return;
                    int color = android.graphics.Color.rgb(rgb[0], rgb[1], rgb[2]);
                    boolean light = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 140;
                    findViewById(R.id.main_container).setBackgroundColor(color);
                    getWindow().getDecorView().setBackgroundColor(color);
                    androidx.core.view.WindowInsetsControllerCompat ctl =
                            androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                    ctl.setAppearanceLightStatusBars(light);
                    ctl.setAppearanceLightNavigationBars(light);
                });
    }

    private static int[] parseCssRgb(String jsValue) {
        if (jsValue == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?")
                .matcher(jsValue);
        if (!m.find()) return null;
        if (m.group(4) != null && Double.parseDouble(m.group(4)) < 0.5) return null;
        return new int[]{Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))};
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        String url = webView.getUrl();
        boolean onRemote = url != null && Uri.parse(url).getHost() != null
                && !WAILS_HOST.equals(Uri.parse(url).getHost());
        if (onRemote) {
            // The injected phone layer (relay /__frp/mobile.js) owns in-app
            // navigation: let it step back first; fall back to URL history.
            webView.evaluateJavascript(
                    "(function(){try{return typeof window.__DSH_MOBILE_BACK__==='function'?String(window.__DSH_MOBILE_BACK__()):'none'}catch(e){return 'none'}})()",
                    value -> {
                        String v = value == null ? "" : value.replace("\"", "");
                        if ("true".equals(v)) return;
                        if ("false".equals(v)) {
                            returnToSettings(null);
                            return;
                        }
                        urlBack();
                    });
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private void urlBack() {
        {
            // Step back inside DSH, but never back onto the one-shot login/token
            // hops; at the start of DSH history return to the settings page.
            android.webkit.WebBackForwardList history = webView.copyBackForwardList();
            int index = history.getCurrentIndex();
            if (index > 0) {
                String previous = history.getItemAtIndex(index - 1).getUrl();
                Uri prev = Uri.parse(previous);
                boolean prevIsRemoteApp = prev.getHost() != null && !WAILS_HOST.equals(prev.getHost())
                        && !String.valueOf(prev.getPath()).startsWith("/__frp/")
                        && prev.getQueryParameter("token") == null;
                if (prevIsRemoteApp) {
                    webView.goBack();
                    return;
                }
            }
            returnToSettings(null);
            return;
        }
    }

    /** Host of the DSH server the user connected to; links elsewhere open externally. */
    private String remoteHost;

    private void returnToSettings(@Nullable String reason) {
        remoteHost = null;
        String url = WAILS_SCHEME + "://" + WAILS_HOST + "/?manual" + (reason != null ? "&reason=" + reason : "");
        webView.loadUrl(url);
        webView.clearHistory();
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (android.content.ActivityNotFoundException e) {
            Log.w(TAG, "No activity for " + uri);
        }
    }
}
