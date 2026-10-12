package com.lucio.bishoptv;

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Precisa vir antes do super.onCreate: é quando o bridge carrega os plugins.
        registerPlugin(NativePlayerPlugin.class);
        registerPlugin(NativeHttpPlugin.class);
        super.onCreate(savedInstanceState);

        // Sem isto o WebView ignora o <meta viewport width=1200>: a TV (1080p a
        // 2x) fica com 960px de largura e cai no layout de celular do CSS.
        WebSettings ws = getBridge().getWebView().getSettings();
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);

        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return recoverFromRendererGone(view, detail);
            }
        });
    }

    /**
     * Com pouca memória, o Android mata o processo que desenha o WebView —
     * sobretudo com o player em primeiro plano, quando a interface fica em
     * segundo plano. Sem tratar isso, o Android encerra o app inteiro ("fecha
     * do nada"). Aqui o WebView morto é descartado e a tela é recriada: a
     * interface volta pelo cache da lista.
     */
    private boolean recoverFromRendererGone(WebView view, RenderProcessGoneDetail detail) {
        // Só chega aqui no Android 8+, mas o minSdk é 24.
        boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash();
        Log.w("BishopTV", "WebView renderer gone (crash=" + crashed + "); recriando a tela");
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.destroy();
        recreate();
        return true;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Tela cheia: a interface foi desenhada para ocupar a tela toda, como na TV. */
    private void hideSystemBars() {
        WindowInsetsControllerCompat c =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
