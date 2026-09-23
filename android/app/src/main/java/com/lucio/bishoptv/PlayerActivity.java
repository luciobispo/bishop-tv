package com.lucio.bishoptv;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

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
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.ui.PlayerView;

/**
 * Player em tela cheia com ExoPlayer (Media3). Devolve posição, duração e se
 * o vídeo terminou, para o app salvar progresso e histórico.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends AppCompatActivity {

    static final String EXTRA_URL = "url";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_SUBTITLE = "subtitle";
    static final String EXTRA_USER_AGENT = "userAgent";
    static final String EXTRA_START_MS = "startMs";
    static final String EXTRA_LIVE = "live";

    static final String RESULT_POSITION_MS = "positionMs";
    static final String RESULT_DURATION_MS = "durationMs";
    static final String RESULT_ENDED = "ended";
    static final String RESULT_ERROR = "error";

    private static final String DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20";
    private static final int MAX_NETWORK_RETRIES = 2;

    private ExoPlayer player;
    private PlayerView playerView;
    private String url;
    private String userAgent;
    private boolean live;
    private boolean forcedHls = false;
    private int networkRetries = 0;
    private boolean ended = false;
    private String error = null;
    private boolean finishing = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        Intent in = getIntent();
        url = in.getStringExtra(EXTRA_URL);
        userAgent = in.getStringExtra(EXTRA_USER_AGENT);
        if (TextUtils.isEmpty(userAgent)) userAgent = DEFAULT_UA;
        live = in.getBooleanExtra(EXTRA_LIVE, false);
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

        player.setMediaSource(buildSource(false));
        if (!live && startMs > 5000) player.seekTo(startMs);
        player.setPlayWhenReady(true);
        player.prepare();
    }

    /* ------------------------------------------------------------------ */

    private View buildLayout(String title, String subtitle) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        playerView.setKeepScreenOn(true);
        root.addView(playerView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Cabeçalho com o título, visível junto com os controles.
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        header.setPadding(pad, dp(18), pad, dp(40));
        header.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { 0xCC000000, 0x00000000 }));

        TextView t = new TextView(this);
        t.setText(title == null ? "" : title);
        t.setTextColor(Color.WHITE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        header.addView(t);

        if (!TextUtils.isEmpty(subtitle)) {
            TextView s = new TextView(this);
            s.setText(subtitle);
            s.setTextColor(0xFFB8B8C2);
            s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            s.setSingleLine(true);
            s.setEllipsize(TextUtils.TruncateAt.END);
            header.addView(s);
        }
        root.addView(header, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));

        playerView.setControllerVisibilityListener(
            (PlayerView.ControllerVisibilityListener) header::setVisibility);
        return root;
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

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null && !finishing) player.pause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (player != null) {
            player.release();
            player = null;
        }
    }
}
