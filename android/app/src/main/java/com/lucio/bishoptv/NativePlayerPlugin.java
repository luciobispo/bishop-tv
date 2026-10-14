package com.lucio.bishoptv;

import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

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
        PlayerActivity.pendingChannels = readChannels(call);
        PlayerActivity.pendingChannelIndex = call.getInt("channelIndex", 0);
        PlayerActivity.pendingChannelsWrap = Boolean.TRUE.equals(call.getBoolean("channelsWrap", true));
        intent.putExtra(PlayerActivity.EXTRA_AUDIO_LANG, call.getString("audioLang", ""));
        intent.putExtra(PlayerActivity.EXTRA_SUB_LANG, call.getString("subLang", "off"));
        // Só itens que podem ir para a Minha Lista mandam "favorite"; os outros ficam sem o coração.
        if (call.getData().has("favorite")) {
            intent.putExtra(PlayerActivity.EXTRA_CAN_FAVORITE, true);
            intent.putExtra(PlayerActivity.EXTRA_FAVORITE, call.getBoolean("favorite", false));
        }
        startActivityForResult(call, intent, "onPlayerClosed");
    }

    /** Canais da categoria para o zapping: [{k, u, f, t, s, v}] (chave, url, reserva, título, subtítulo, favorito). */
    private static List<PlayerActivity.Channel> readChannels(PluginCall call) {
        JSONArray arr = call.getData().optJSONArray("channels");
        if (arr == null || arr.length() < 2) return null;
        List<PlayerActivity.Channel> out = new ArrayList<>(arr.length());
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || o.optString("u").isEmpty()) return null;  // índices desalinhados: melhor sem zapping
            String fallback = o.optString("f", "");
            out.add(new PlayerActivity.Channel(o.optString("k"), o.optString("u"),
                fallback.isEmpty() ? null : fallback, o.optString("t"), o.optString("s"), o.optBoolean("v")));
        }
        return out;
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
            String channelKey = data.getStringExtra(PlayerActivity.RESULT_CHANNEL_KEY);
            if (channelKey != null) ret.put("channelKey", channelKey);
            String favs = data.getStringExtra(PlayerActivity.RESULT_FAVORITES);
            if (favs != null) {
                try { ret.put("favorites", new JSONObject(favs)); } catch (JSONException ignored) {}
            }
        }
        call.resolve(ret);
    }
}
