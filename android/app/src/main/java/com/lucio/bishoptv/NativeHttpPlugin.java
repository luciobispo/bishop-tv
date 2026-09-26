package com.lucio.bishoptv;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * GET nativo para listas M3U e API Xtream. Substitui o CapacitorHttp porque
 * precisa do mesmo DNS com fallback ({@link FallbackDns}) que o player usa.
 *
 * A resposta é gravada direto num arquivo em cache e o WebView a lê pelo
 * servidor local do Capacitor (convertFileSrc). Ela nunca passa inteira pela
 * memória Java nem pela ponte JS: listas chegam a dezenas de MB e o heap de um
 * Firestick tem 128–256 MB — com o corpo numa String o app morria ao carregar.
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private static final String DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private File dir;

    @Override
    public void load() {
        dir = new File(getContext().getCacheDir(), "http");
        // Sobras de uma sessão que fechou no meio de um download.
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        dir.mkdirs();
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("URL vazia");
            return;
        }
        String userAgent = call.getString("userAgent", DEFAULT_UA);
        Object t = call.getData().opt("timeoutMs");
        long timeoutMs = t instanceof Number ? ((Number) t).longValue() : 30000L;

        pool.execute(() -> {
            // Timeout por leitura, não da chamada inteira: listas grandes demoram a baixar.
            OkHttpClient client = Net.client().newBuilder()
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build();
            Request request;
            try {
                request = new Request.Builder()
                    .url(url.trim())
                    .header("User-Agent", userAgent)
                    .header("Accept", "*/*")
                    .build();
            } catch (IllegalArgumentException e) {
                call.reject("Failed to parse URL: " + url);
                return;
            }
            File out = new File(dir, UUID.randomUUID().toString());
            try (Response res = client.newCall(request).execute()) {
                JSObject ret = new JSObject();
                ret.put("status", res.code());
                ret.put("url", res.request().url().toString());
                ResponseBody body = res.body();
                if (res.isSuccessful() && body != null) {
                    try (InputStream in = body.byteStream(); OutputStream os = new FileOutputStream(out)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
                    }
                    ret.put("path", out.getAbsolutePath());
                    ret.put("size", out.length());
                }
                call.resolve(ret);
            } catch (IOException e) {
                out.delete();
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        });
    }

    /** Apaga um arquivo criado por {@link #download} depois que o JS o leu. */
    @PluginMethod
    public void discard(PluginCall call) {
        String path = call.getString("path");
        if (path != null) {
            File f = new File(path);
            if (dir.equals(f.getParentFile())) f.delete();
        }
        call.resolve();
    }
}
