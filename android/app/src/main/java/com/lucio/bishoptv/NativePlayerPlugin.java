package com.lucio.bishoptv;

import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ponte entre a interface web e o {@link PlayerActivity}.
 *
 * No Android o vídeo não passa pelo WebView: servidores IPTV não enviam CORS
 * e streams .ts ao vivo não terminam nunca, então hls.js/mpegts.js não servem.
 * O ExoPlayer resolve os dois problemas e ainda toca MKV.
 */
@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Este item não possui um link de reprodução.");
            return;
        }
        // Números pequenos chegam do JS como Integer; getLong() os ignoraria.
        Object start = call.getData().opt("startMs");

        Intent intent = new Intent(getContext(), PlayerActivity.class);
        intent.putExtra(PlayerActivity.EXTRA_URL, url.trim());
        intent.putExtra(PlayerActivity.EXTRA_TITLE, call.getString("title", ""));
        intent.putExtra(PlayerActivity.EXTRA_SUBTITLE, call.getString("subtitle", ""));
        intent.putExtra(PlayerActivity.EXTRA_ASPECT_RATIO, call.getString("aspectRatio", "fit"));
        intent.putExtra(PlayerActivity.EXTRA_USER_AGENT, call.getString("userAgent", ""));
        intent.putExtra(PlayerActivity.EXTRA_START_MS, start instanceof Number ? ((Number) start).longValue() : 0L);
        intent.putExtra(PlayerActivity.EXTRA_LIVE, call.getBoolean("live", false));
        intent.putExtra(PlayerActivity.EXTRA_FALLBACK_URL, call.getString("fallbackUrl"));
        intent.putExtra(PlayerActivity.EXTRA_BUFFER, call.getString("buffer", "normal"));
        // Ao vivo: programação do canal (EPG) a partir de agora, [{title, start, stop}] em ms.
        JSArray epg = call.getArray("epg");
        if (epg != null) intent.putExtra(PlayerActivity.EXTRA_EPG, epg.toString());
        // Só itens que podem ir para a Minha Lista mandam "favorite"; os outros ficam sem o coração.
        if (call.getData().has("favorite")) {
            intent.putExtra(PlayerActivity.EXTRA_CAN_FAVORITE, true);
            intent.putExtra(PlayerActivity.EXTRA_FAVORITE, call.getBoolean("favorite", false));
        }
        startActivityForResult(call, intent, "onPlayerClosed");
    }

    @ActivityCallback
    private void onPlayerClosed(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        Intent data = result.getData();
        if (data != null) {
            ret.put("positionMs", data.getLongExtra(PlayerActivity.RESULT_POSITION_MS, 0));
            ret.put("durationMs", data.getLongExtra(PlayerActivity.RESULT_DURATION_MS, 0));
            ret.put("ended", data.getBooleanExtra(PlayerActivity.RESULT_ENDED, false));
            ret.put("aspectRatio", data.getStringExtra(PlayerActivity.RESULT_ASPECT_RATIO));
            String error = data.getStringExtra(PlayerActivity.RESULT_ERROR);
            if (error != null) ret.put("error", error);
            if (data.hasExtra(PlayerActivity.RESULT_FAVORITE)) {
                ret.put("favorite", data.getBooleanExtra(PlayerActivity.RESULT_FAVORITE, false));
            }
        }
        call.resolve(ret);
    }
}
