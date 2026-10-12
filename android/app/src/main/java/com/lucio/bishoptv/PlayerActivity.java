package com.lucio.bishoptv;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Locale;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.AspectRatioFrameLayout;

/**
 * Player em tela cheia com ExoPlayer (Media3). Devolve posição, duração e se
 * o vídeo terminou, para o app salvar progresso e histórico.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends AppCompatActivity {

    static final String EXTRA_URL = "url";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_SUBTITLE = "subtitle";
    static final String EXTRA_ASPECT_RATIO = "aspectRatio";
    static final String EXTRA_USER_AGENT = "userAgent";
    static final String EXTRA_START_MS = "startMs";
    static final String EXTRA_LIVE = "live";
    static final String EXTRA_FALLBACK_URL = "fallbackUrl";
    static final String EXTRA_BUFFER = "buffer";
    static final String EXTRA_CAN_FAVORITE = "canFavorite";
    static final String EXTRA_FAVORITE = "favorite";
    static final String RESULT_POSITION_MS = "positionMs";
    static final String RESULT_DURATION_MS = "durationMs";
    static final String RESULT_ENDED = "ended";
    static final String RESULT_ERROR = "error";
    static final String RESULT_FAVORITE = "favorite";
    static final String RESULT_ASPECT_RATIO = "aspectRatio";

    private static final String DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";
    private static final int MAX_NETWORK_RETRIES = 2;
    private static final long SEEK_STEP_MS = 10000;

    private ExoPlayer player;
    private PlayerView playerView;
    private AspectRatioFrameLayout aspectFrame;
    private ImageButton aspectButton;
    private String aspectRatio = "fit";
    private String url;
    private String fallbackUrl;
    private String bufferPref;
    private String userAgent;
    private boolean live;
    private boolean forcedHls = false;
    private int networkRetries = 0;
    private boolean ended = false;
    private String error = null;
    private boolean finishing = false;
    private boolean stoppedInBackground = false;
    private boolean canFavorite;
    private boolean favorite;
    private ImageButton favButton;
    private TextView osd;
    private final Runnable hideOsd = () -> osd.animate().alpha(0f).setDuration(250)
        .withEndAction(() -> osd.setVisibility(View.GONE));

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        Intent in = getIntent();
        url = in.getStringExtra(EXTRA_URL);
        userAgent = in.getStringExtra(EXTRA_USER_AGENT);
        String savedAspectRatio = in.getStringExtra(EXTRA_ASPECT_RATIO);
        if ("4:3".equals(savedAspectRatio) || "16:9".equals(savedAspectRatio)) aspectRatio = savedAspectRatio;
        if (TextUtils.isEmpty(userAgent)) userAgent = DEFAULT_UA;
        live = in.getBooleanExtra(EXTRA_LIVE, false);
        fallbackUrl = in.getStringExtra(EXTRA_FALLBACK_URL);
        bufferPref = in.getStringExtra(EXTRA_BUFFER);
        if (bufferPref == null) bufferPref = "normal";
        canFavorite = in.getBooleanExtra(EXTRA_CAN_FAVORITE, false);
        favorite = in.getBooleanExtra(EXTRA_FAVORITE, false);
        long startMs = in.getLongExtra(EXTRA_START_MS, 0L);

        setContentView(buildLayout(in.getStringExtra(EXTRA_TITLE), in.getStringExtra(EXTRA_SUBTITLE)));
        hideSystemBars();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                finishWithResult();
            }
        });

        player = new ExoPlayer.Builder(this)
            .setRenderersFactory(new DefaultRenderersFactory(this).setEnableDecoderFallback(true))
            .setLoadControl(buildLoadControl())
            .setSeekBackIncrementMs(SEEK_STEP_MS)
            .setSeekForwardIncrementMs(SEEK_STEP_MS)
            .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) networkRetries = 0;
                if (state == Player.STATE_ENDED && !live) {
                    ended = true;
                    finishWithResult();
                }
            }

            @Override
            public void onPlayerError(PlaybackException e) {
                handleError(e);
            }
        });
        playerView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onVideoSizeChanged(androidx.media3.common.VideoSize videoSize) {
                applyAspectRatio();
            }
        });

        player.setMediaSource(buildSource(false));
        if (!live && startMs > 5000) player.seekTo(startMs);
        player.setPlayWhenReady(true);
        player.prepare();
    }

    /* ------------------------------------------------------------------ */

    private View buildLayout(String title, String subtitle) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        // O controle é o layout player_controls.xml (ligado em player_view.xml).
        playerView = (PlayerView) getLayoutInflater().inflate(R.layout.player_view, root, false);
        root.addView(playerView);
        View videoSurface = playerView.getVideoSurfaceView();
        if (videoSurface != null && videoSurface.getParent() instanceof AspectRatioFrameLayout) {
            aspectFrame = (AspectRatioFrameLayout) videoSurface.getParent();
        }
        aspectButton = playerView.findViewById(R.id.bishop_aspect);
        aspectButton.setOnClickListener(v -> cycleAspectRatio());
        applyAspectRatio();

        ((TextView) playerView.findViewById(R.id.bishop_title)).setText(title == null ? "" : title);
        if (!TextUtils.isEmpty(subtitle)) {
            TextView sub = playerView.findViewById(R.id.bishop_subtitle);
            sub.setText(subtitle);
            sub.setVisibility(View.VISIBLE);
        }
        playerView.findViewById(R.id.bishop_back).setOnClickListener(v -> finishWithResult());

        favButton = playerView.findViewById(R.id.bishop_fav);
        if (canFavorite) {
            favButton.setVisibility(View.VISIBLE);
            favButton.setOnClickListener(v -> toggleFavorite());
            updateFavIcon();
        }

        if (live) {
            // Ao vivo não tem linha do tempo nem como avançar ou voltar.
            playerView.setShowRewindButton(false);
            playerView.setShowFastForwardButton(false);
            playerView.findViewById(R.id.bishop_timeline).setVisibility(View.GONE);
            // Ao vivo não tem linha do tempo.
            playerView.findViewById(R.id.bishop_live).setVisibility(View.VISIBLE);
        }

        // Aviso do salto (⏪/⏩ e setas), visível mesmo com o controle escondido.
        osd = new TextView(this);
        osd.setTextColor(Color.WHITE);
        osd.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        osd.setBackgroundResource(R.drawable.player_osd_bg);
        osd.setPadding(dp(22), dp(10), dp(22), dp(10));
        osd.setVisibility(View.GONE);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        lp.topMargin = dp(96);
        root.addView(osd, lp);
        return root;
    }

    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */

    private void toggleFavorite() {
        favorite = !favorite;
        updateFavIcon();
        Toast.makeText(this, favorite ? "Adicionado à Minha Lista" : "Removido da Minha Lista",
            Toast.LENGTH_SHORT).show();
    }

    private void cycleAspectRatio() {
        if ("4:3".equals(aspectRatio)) aspectRatio = "16:9";
        else if ("16:9".equals(aspectRatio)) aspectRatio = "fit";
        else aspectRatio = "4:3";
        applyAspectRatio();
        Toast.makeText(this, aspectRatioLabel(), Toast.LENGTH_SHORT).show();
    }

    private String aspectRatioLabel() {
        return "Proporção: " + ("fit".equals(aspectRatio) ? "Ajustar à tela" : aspectRatio);
    }

    private void applyAspectRatio() {
        if (aspectFrame == null) return;
        if ("fit".equals(aspectRatio)) {
            aspectFrame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
            aspectFrame.setAspectRatio(0f);
        } else {
            aspectFrame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FILL);
            aspectFrame.setAspectRatio("4:3".equals(aspectRatio) ? 4f / 3f : 16f / 9f);
        }
        aspectButton.setContentDescription(aspectRatioLabel());
    }

    private void updateFavIcon() {
        favButton.setImageResource(favorite ? R.drawable.ic_player_fav_on : R.drawable.ic_player_fav_off);
    }

    /* ------------------------------------------------------------------ */

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (player != null && handleSeekKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }

    /**
     * ⏪/⏩ do controle remoto saltam direto, sem abrir o menu. Com o menu
     * escondido, as setas esquerda/direita fazem o mesmo. Segurar a tecla
     * acelera: 10 s, depois 30 s, depois 1 min por salto.
     */
    private boolean handleSeekKey(KeyEvent e) {
        int code = e.getKeyCode();
        boolean media = code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || code == KeyEvent.KEYCODE_MEDIA_REWIND;
        boolean arrow = (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT)
            && !playerView.isControllerFullyVisible();
        if (!media && !arrow) return false;
        // Ao vivo: ⏪/⏩ não fazem nada; as setas seguem o padrão (abrem o menu).
        if (!canSeek()) return media;
        if (e.getAction() != KeyEvent.ACTION_DOWN) return true;

        int repeat = e.getRepeatCount();
        // A repetição da tecla chega a ~20 por segundo: usa só uma a cada três.
        if (repeat > 0 && repeat % 3 != 0) return true;
        long step = repeat < 15 ? SEEK_STEP_MS : repeat < 45 ? 30000 : 60000;
        boolean forward = code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD || code == KeyEvent.KEYCODE_DPAD_RIGHT;
        seekBy(forward ? step : -step);
        return true;
    }

    private boolean canSeek() {
        return !live && player.isCurrentMediaItemSeekable() && player.getDuration() != C.TIME_UNSET;
    }

    private void seekBy(long deltaMs) {
        long duration = player.getDuration();
        // A posição já reflete o salto anterior, mesmo antes de o vídeo carregar.
        long target = Math.max(0, Math.min(player.getCurrentPosition() + deltaMs, duration - 1000));
        player.seekTo(target);
        showOsd((deltaMs > 0 ? "\u00BB  " : "\u00AB  ") + formatTime(target) + " / " + formatTime(duration));
    }

    private void showOsd(String text) {
        osd.removeCallbacks(hideOsd);
        osd.animate().cancel();
        osd.setText(text);
        osd.setAlpha(1f);
        osd.setVisibility(View.VISIBLE);
        osd.postDelayed(hideOsd, 1500);
    }

    private static String formatTime(long ms) {
        long s = Math.max(0, ms / 1000);
        long h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
        return h > 0
            ? String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec)
            : String.format(Locale.ROOT, "%02d:%02d", m, sec);
    }

    /**
     * O padrão do ExoPlayer volta a tocar com só 2,5 s no buffer (5 s depois de
     * um travamento). Em IPTV ao vivo o servidor entrega o vídeo quase na mesma
     * velocidade em que ele toca, então esse colchão nunca cresce e qualquer
     * oscilação da rede vira "carregando" a cada poucos segundos. Aqui o
     * colchão é maior — sobretudo depois de um travamento — e o total em bytes
     * tem teto, porque o buffer mora no heap Java e o Firestick tem pouco.
     */
    private LoadControl buildLoadControl() {
        int startMs, rebufferMs, maxMs, maxMb;
        switch (bufferPref) {
            case "low":
                startMs = live ? 2000 : 1500;
                rebufferMs = live ? 4000 : 3000;
                maxMs = 30000;
                maxMb = 32;
                break;
            case "high":
                startMs = live ? 6000 : 4000;
                rebufferMs = live ? 15000 : 10000;
                maxMs = 90000;
                maxMb = 96;
                break;
            default:
                startMs = live ? 4000 : 2500;
                rebufferMs = live ? 10000 : 6000;
                maxMs = 50000;
                maxMb = 64;
        }
        // Nunca mais que 1/4 do heap: com o resto do app e o decodificador, um
        // buffer maior estoura a memória nos Firesticks de heap menor.
        long heapMb = Runtime.getRuntime().maxMemory() / (1024 * 1024);
        maxMb = (int) Math.max(16, Math.min(maxMb, heapMb / 4));
        return new DefaultLoadControl.Builder()
            // min == max: continua baixando sem parar enquanto houver espaço.
            .setBufferDurationsMs(maxMs, maxMs, startMs, rebufferMs)
            .setTargetBufferBytes(maxMb * 1024 * 1024)
            .setPrioritizeTimeOverSizeThresholds(false)
            .build();
    }

    /**
     * A extensão resolve quase tudo; sem ela, o ExoPlayer identifica TS, MP4
     * e MKV pelos bytes. HLS sem ".m3u8" no endereço precisa ser forçado —
     * é o que {@link #handleError} faz quando o formato não é reconhecido.
     */
    private MediaSource buildSource(boolean asHls) {
        // OkHttp com o DNS de fallback (Google/Cloudflare) — ver Net e FallbackDns.
        OkHttpDataSource.Factory http = new OkHttpDataSource.Factory(Net.client())
            .setUserAgent(userAgent);

        DefaultExtractorsFactory extractors = new DefaultExtractorsFactory()
            .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES);

        MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
        if (asHls || looksHls(url)) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        if (live) {
            // Sem acelerar para alcançar a borda ao vivo: encostado nela, o
            // player para a cada segmento esperando o próximo ser publicado.
            MediaItem.LiveConfiguration.Builder lc = new MediaItem.LiveConfiguration.Builder()
                .setMinPlaybackSpeed(1f)
                .setMaxPlaybackSpeed(1f);
            if ("high".equals(bufferPref)) lc.setTargetOffsetMs(30000);
            item.setLiveConfiguration(lc.build());
        }

        return new DefaultMediaSourceFactory(http, extractors).createMediaSource(item.build());
    }

    private static boolean looksHls(String u) {
        String path = u.split("\\?")[0].toLowerCase();
        return path.endsWith(".m3u8") || path.endsWith("/m3u8");
    }

    private void handleError(PlaybackException e) {
        int code = e.errorCode;

        // Formato não reconhecido: pode ser HLS servido sem extensão.
        if (!forcedHls && !looksHls(url) && (code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
                || code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED)) {
            forcedHls = true;
            player.setMediaSource(buildSource(true));
            player.prepare();
            return;
        }

        // Ao vivo: a janela andou enquanto o buffer esvaziava.
        if (code == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            player.seekToDefaultPosition();
            player.prepare();
            return;
        }

        // Quedas momentâneas de rede são comuns em IPTV.
        if ((code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || code == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                || code == PlaybackException.ERROR_CODE_IO_UNSPECIFIED)
                && networkRetries < MAX_NETWORK_RETRIES) {
            networkRetries++;
            if (live) player.seekToDefaultPosition();
            player.prepare();
            return;
        }

        // Formato alternativo (ver Player.nativeUrls no JS): o .ts falhou, tenta o .m3u8.
        if (fallbackUrl != null && !fallbackUrl.equals(url)) {
            url = fallbackUrl;
            fallbackUrl = null;
            forcedHls = false;
            networkRetries = 0;
            player.setMediaSource(buildSource(false));
            player.prepare();
            return;
        }

        error = describe(e);
        finishWithResult();
    }

    private static String describe(PlaybackException e) {
        switch (e.errorCode) {
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS: {
                Throwable cause = e.getCause();
                int status = cause instanceof HttpDataSource.InvalidResponseCodeException
                    ? ((HttpDataSource.InvalidResponseCodeException) cause).responseCode : 0;
                if (status == 401 || status == 403) {
                    return "O servidor recusou o acesso (" + status + "): usuário, senha, assinatura ou limite de conexões.";
                }
                if (status == 404) {
                    return "Este canal não existe mais no servidor (404) — o link da lista pode estar desatualizado.";
                }
                return "O servidor respondeu " + status + " para este item.";
            }
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
                return "Não foi possível conectar ao servidor. Confira a internet ou se o endereço ainda existe.";
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "O servidor não respondeu a tempo.";
            case PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED:
                return "O Android bloqueou a conexão sem criptografia (http).";
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED:
                return "O servidor não entregou um vídeo válido — provavelmente uma página de erro "
                    + "(canal fora do ar, login recusado ou limite de conexões).";
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
            case PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED:
                return "Este aparelho não consegue decodificar o vídeo (codec não suportado, "
                    + "comum com HEVC/4K em aparelhos mais antigos).";
            default:
                return "Falha na reprodução (" + e.getErrorCodeName() + ").";
        }
    }

    /* ------------------------------------------------------------------ */

    private void finishWithResult() {
        if (finishing) return;
        finishing = true;
        Intent data = new Intent();
        if (player != null) {
            long duration = player.getDuration();
            data.putExtra(RESULT_POSITION_MS, Math.max(0, player.getCurrentPosition()));
            data.putExtra(RESULT_DURATION_MS, duration == C.TIME_UNSET ? 0 : duration);
        }
        data.putExtra(RESULT_ENDED, ended);
        data.putExtra(RESULT_ASPECT_RATIO, aspectRatio);
        if (canFavorite) data.putExtra(RESULT_FAVORITE, favorite);
        if (error != null) data.putExtra(RESULT_ERROR, error);
        setResult(RESULT_OK, data);
        finish();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    /**
     * Em segundo plano (botão Home), o buffer — dezenas de MB — é liberado:
     * um app parado ocupando essa memória é o primeiro que o Android mata.
     * Ao voltar, o filme recarrega na mesma posição (pausado, como antes) e
     * o ao vivo volta direto para a borda, tocando.
     */
    @Override
    protected void onStart() {
        super.onStart();
        if (player == null || !stoppedInBackground) return;
        stoppedInBackground = false;
        if (live) {
            player.seekToDefaultPosition();
            player.setPlayWhenReady(true);
        }
        player.prepare();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null && !finishing) {
            player.setPlayWhenReady(false);
            player.stop();
            stoppedInBackground = true;
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (osd != null) osd.removeCallbacks(hideOsd);
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
