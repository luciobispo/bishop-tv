package com.lucio.bishoptv;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/** Cliente HTTP único do app: listas, API Xtream e o ExoPlayer passam por ele. */
final class Net {

    private static OkHttpClient client;

    private Net() {
    }

    static synchronized OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                .dns(new FallbackDns())
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .followRedirects(true)
                .followSslRedirects(true) // painéis redirecionam entre http e https
                .retryOnConnectionFailure(true)
                .build();
        }
        return client;
    }
}
