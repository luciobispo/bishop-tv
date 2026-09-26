package com.lucio.bishoptv;

import android.os.Bundle;
import android.webkit.WebSettings;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

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
