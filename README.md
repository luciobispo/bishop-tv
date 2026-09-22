# BishopTV — player IPTV com interface estilo Netflix

App desktop (Windows) que lê suas listas IPTV e apresenta tudo numa interface de streaming:
banner de destaque, carrosséis por categoria, capas, "Continuar assistindo", Minha Lista,
busca e player com controles completos.

O app **não inclui, não hospeda e não distribui nenhum conteúdo** — ele apenas reproduz as
listas que você fornecer.

---

## Instalação

```bash
npm install
```

## Rodar

```bash
npm start
```

Modo desenvolvimento (abre o DevTools e espelha o console no terminal):

```bash
npm run dev
```

## Gerar o instalador `.exe`

```bash
npm run dist
```

Sai em `dist/`: um instalador NSIS e uma versão portátil, ambos x64.

## Rodar com Docker

O BishopTV é um app desktop, então o container roda o Electron num display virtual e mostra a
tela no navegador (noVNC):

```bash
docker compose up -d --build
```

Abra `http://localhost:6080/vnc.html?autoconnect=1&resize=scale`.

- **Dados** (listas, credenciais, favoritos, progresso, cache) ficam no volume `bishoptv-data`,
  montado em `/home/node/.config/BishopTV`. Sobrevivem a `down`/`up`; `docker compose down -v`
  apaga tudo.
- **Arquivos `.m3u`** colocados em `./listas` aparecem em `/home/node/listas` no seletor do app.
- **Senha do VNC**: `VNC_PASSWORD=... docker compose up -d`. Sem ela, a porta só é publicada em
  `127.0.0.1`.
- **Resolução**: `SCREEN_RESOLUTION=1920x1080`.

O noVNC **não transmite áudio**. No Windows 11 com Docker Desktop (WSL2) dá para abrir como
janela nativa, com som, usando o WSLg:

```bash
docker compose -f docker-compose.yml -f docker-compose.wslg.yml up -d --build
```

---

## Como adicionar suas listas

Na primeira abertura o app pergunta a origem. Depois, use o ícone de **lista** na barra superior
(**Fontes / Listas**). Três formatos aceitos, e você pode manter várias listas salvas e alternar
entre elas:

| Tipo | O que informar |
|---|---|
| **Arquivo .m3u** | Escolha o arquivo ou arraste-o para qualquer lugar da janela |
| **URL da lista** | O link `http(s)://…` que o provedor forneceu (`get.php?…&type=m3u_plus`) |
| **Xtream Codes** | Servidor (`http://host:porta`), usuário e senha |

Existe um `lista-exemplo.m3u` na raiz do projeto com streams públicos de teste
(Blender/Creative Commons e streams de demonstração do Mux e da Apple), útil para conferir se
tudo está funcionando antes de carregar sua lista real.

### Prefira Xtream Codes quando o provedor oferecer os dois

Se você tem o link `get.php?...&type=m3u_plus` **e** as credenciais do painel, vale cadastrar
por Xtream. Além dos metadados, há duas razões práticas:

- **Os links da `.m3u` podem ser tokens temporários.** Vários painéis geram URLs do tipo
  `.../play/<token>/ts` que expiram ou simplesmente deixam de existir, e aí o canal responde
  `INVALID_STREAM_ID` mesmo com a assinatura ativa. Pelo Xtream o app monta a URL canônica
  (`/live/usuario/senha/<id>.m3u8`), que não depende de token.
- **É muito mais leve.** Numa mesma conta, a `.m3u` trouxe 271 mil linhas (cada episódio é uma
  linha) contra 29 mil itens pela API — as séries vêm como um objeto só, com os episódios
  carregados sob demanda.

### O que muda com Xtream Codes

Conectando por Xtream o app puxa metadados que uma lista `.m3u` comum não tem: sinopse, elenco,
direção, gênero, nota, ano, pôsteres, capas de fundo e a estrutura real de temporadas e episódios
das séries. Com `.m3u` puro, o app deduz as séries a partir dos nomes dos arquivos
(`Nome S01E02`, `Nome 1x02`, `Nome Temporada 1 Episodio 2`).

---

## Recursos

**Catálogo**
- Classificação automática em TV ao Vivo, Filmes e Séries
- Agrupamento de episódios soltos em séries, com seletor de temporada
- Categorias na lateral, filtro por texto dentro da categoria e busca global (`Ctrl+K`)
- Minha Lista (favoritos) e Continuar assistindo, com barra de progresso nas capas
- Cache em disco das listas: a reabertura é instantânea, e listas com mais de 12h
  são atualizadas em segundo plano

**Player**
- HLS (`.m3u8`) via hls.js, MPEG-TS (`.ts`) via mpegts.js, e MP4/WebM nativo
- Botão "tentar outro formato" que alterna entre `.m3u8` e `.ts` quando o canal não abre
- Seleção de qualidade, faixa de áudio e legendas
- Zapping lateral com busca de canal, e troca de canal pelas setas ↑ ↓
- Retomada automática de filmes e episódios; episódio seguinte toca sozinho
- Picture-in-picture, tela cheia, e a tela não apaga durante a reprodução

**Atalhos**

| Tecla | Ação |
|---|---|
| `Espaço` / `K` | Play / pausa |
| `←` `→` | Voltar / avançar 10s |
| `↑` `↓` | Volume — ou trocar de canal, ao vivo |
| `F` / `F11` | Tela cheia |
| `M` | Mudo |
| `C` | Lista de canais (zapping) |
| `Esc` | Sair do player |
| `Ctrl+K` | Buscar |

---

## Quando um canal não abre

O player não se limita a dizer "não deu": quando algo falha, ele consulta o servidor para
descobrir o que está sendo devolvido de fato e mostra o motivo. Painéis IPTV costumam responder
HTTP 200 com uma *página HTML de erro* no lugar do vídeo, e o app traduz os casos conhecidos:

| Mensagem do servidor | O que significa |
|---|---|
| `INVALID_STREAM_ID` | O canal não existe mais nesse endereço — link da lista desatualizado. Recadastre por Xtream. |
| `INVALID_USER` | Usuário ou senha recusados |
| `EXPIRED_ACCOUNT` | Assinatura vencida |
| `MAX_CONNECTIONS` | Limite de conexões simultâneas atingido (feche outro dispositivo) |
| `BANNED` / `DISABLED` | Conta bloqueada ou desativada pelo provedor |

Se o erro não for nenhum desses, tente nesta ordem: **Tentar outro formato** (alterna entre
`.m3u8` e `.ts`), depois trocar o **User-Agent** em Configurações, depois **Atualizar** a lista
em Fontes.

## Quando a lista inteira não carrega

Erros de conexão vêm traduzidos, com o host mostrado na mensagem:

| Situação | O que fazer |
|---|---|
| *o endereço "…" não existe — o DNS não encontrou esse domínio* | O domínio saiu do ar ou mudou. Painéis IPTV trocam de endereço com frequência: peça a URL atualizada a quem fornece a lista. Não adianta tentar de novo. |
| *o servidor recusou a conexão* | O host existe, mas nada atende naquela porta — confira a porta na URL |
| *não respondeu a tempo* | Servidor sobrecarregado; tente mais tarde |
| *respondeu 401/403* | Usuário, senha ou assinatura recusados |
| *respondeu algo que não é JSON* | Em Xtream, quase sempre é login errado: o painel devolve uma página HTML |
| *não é uma URL válida* | A URL foi colada pela metade ou com quebra de linha |

Endereços colados de aplicativos de mensagem costumam vir com espaços invisíveis; o app remove
esses caracteres automaticamente antes de tentar conectar.

Para URLs sem extensão — comuns em links de painel — o app pergunta ao servidor o `content-type`
antes de escolher o motor, em vez de chutar pela aparência do endereço.

## Configurações que importam

- **User-Agent** — vários servidores IPTV só entregam o stream para players conhecidos. O padrão
  é `VLC/3.0.20 LibVLC/3.0.20`; se um canal não abrir, esse é o primeiro ajuste a tentar.
- **Buffer do stream ao vivo** — "Alto" reduz travadas em conexões instáveis, ao custo de mais
  atraso; "Baixo" deixa mais responsivo.
- **Limpar cache** — força releitura completa da lista na próxima abertura.

Tudo (listas, credenciais, favoritos, progresso) fica salvo apenas neste computador, em
`%APPDATA%/BishopTV/`. O caminho exato aparece no rodapé da tela de Configurações.

> O app se chamava **NeoTV** antes. Como o Electron deriva a pasta de dados do nome do produto,
> na primeira abertura com o nome novo a configuração antiga (`%APPDATA%/NeoTV/`) é copiada
> automaticamente — listas, favoritos e histórico continuam lá. A pasta antiga não é apagada;
> se quiser, remova-a à mão depois de confirmar que está tudo certo.

---

## Estrutura

```
main.js            processo principal: janela, IPC, HTTP sem CORS, cache em disco
preload.js         ponte segura entre o renderer e o Node (contextBridge)
src/index.html     estrutura das telas
src/css/app.css    tema escuro estilo Netflix
src/js/util.js     helpers (texto, tempo, DOM, toasts)
src/js/store.js    estado persistido: fontes, favoritos, progresso, ajustes
src/js/m3u.js      parser M3U / M3U Plus e detecção de tipo e episódios
src/js/xtream.js   cliente da API Xtream Codes
src/js/library.js  índice do catálogo: categorias, busca, fileiras da home
src/js/player.js   motores de reprodução e controles
src/js/ui.js       renderização das telas
src/js/app.js      inicialização e ligação dos eventos
```

---

## Notas técnicas

**`webSecurity` está desativado** em `main.js`. Servidores IPTV quase nunca enviam cabeçalhos
CORS, e sem isso o Chromium recusaria os streams. Como o app só carrega páginas locais, a
exposição se limita às URLs que você mesmo cadastra — mas vale saber que é uma troca consciente:
uma lista de origem duvidosa passa a ter mais alcance dentro do processo do renderer do que teria
num app com a política padrão. Se preferir voltar ao padrão, troque `webSecurity: false` por
`true` em `main.js`; os cabeçalhos CORS injetados em `onHeadersReceived` cobrem parte dos casos,
mas nem todos os provedores vão funcionar.

**Certificados autoassinados** são aceitos (`ignore-certificate-errors`), situação comum em
painéis IPTV.

**Arquivos `.mkv`** podem não tocar: o Chromium não suporta o container Matroska. `.mp4`, `.ts`,
`.m3u8` e `.webm` funcionam.

**Listas grandes** (50 mil+ itens) são indexadas em blocos para não travar a interface, e as
grades renderizam em páginas conforme você rola.
#   b i s h o p - t v  
 