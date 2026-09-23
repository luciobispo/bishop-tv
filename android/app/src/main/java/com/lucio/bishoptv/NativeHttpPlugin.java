package com.lucio.bishoptv;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
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
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private static final String DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";
    private final ExecutorService pool = Executors.newCachedThreadPool();

    @PluginMethod
    public void get(PluginCall call) {
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
            try (Response res = client.newCall(request).execute()) {
                ResponseBody body = res.body();
                JSObject ret = new JSObject();
                ret.put("status", res.code());
                ret.put("url", res.request().url().toString());
                ret.put("data", body != null ? body.string() : "");
                call.resolve(ret);
            } catch (IOException e) {
                call.reject(e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        });
    }
}
