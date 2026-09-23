package com.lucio.bishoptv;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.dnsoverhttps.DnsOverHttps;

/**
 * DNS do sistema primeiro; se o domínio não resolver, Google e depois
 * Cloudflare via DNS-over-HTTPS.
 *
 * Provedores de internet costumam bloquear domínios de IPTV respondendo
 * "domínio não existe" no DNS do roteador. Como o DoH vai por HTTPS direto
 * aos IPs do Google/Cloudflare, o roteador não consegue interferir.
 */
final class FallbackDns implements Dns {

    private final List<Dns> doh = new ArrayList<>();
    /** Domínios que já precisaram do DoH: não perdem tempo com o DNS do sistema de novo. */
    private final Set<String> needsDoh = ConcurrentHashMap.newKeySet();

    FallbackDns() {
        OkHttpClient bootstrap = new OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .build();
        doh.add(build(bootstrap, "https://dns.google/dns-query", "8.8.8.8", "8.8.4.4"));
        doh.add(build(bootstrap, "https://cloudflare-dns.com/dns-query", "1.1.1.1", "1.0.0.1"));
    }

    /** Os IPs fixos evitam depender do próprio DNS do sistema para achar o servidor DoH. */
    private static Dns build(OkHttpClient client, String url, String... bootstrapIps) {
        List<InetAddress> hosts = new ArrayList<>();
        for (String ip : bootstrapIps) {
            try {
                hosts.add(InetAddress.getByName(ip)); // IP literal: não faz consulta de rede
            } catch (UnknownHostException ignored) {
            }
        }
        return new DnsOverHttps.Builder()
            .client(client)
            .url(HttpUrl.get(url))
            .bootstrapDnsHosts(hosts)
            .build();
    }

    @Override
    public List<InetAddress> lookup(String hostname) throws UnknownHostException {
        UnknownHostException firstError = null;

        if (!needsDoh.contains(hostname)) {
            try {
                return Dns.SYSTEM.lookup(hostname);
            } catch (UnknownHostException e) {
                firstError = e;
            }
        }

        for (Dns resolver : doh) {
            try {
                List<InetAddress> result = resolver.lookup(hostname);
                if (!result.isEmpty()) {
                    needsDoh.add(hostname);
                    return result;
                }
            } catch (UnknownHostException e) {
                if (firstError == null) firstError = e;
            }
        }
        throw firstError != null ? firstError : new UnknownHostException(hostname);
    }
}
