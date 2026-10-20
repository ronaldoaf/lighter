# Lighter paper trading — fade de pico de volume

Este app grava continuamente o livro de ofertas de todos os perps da Lighter. Ao mesmo tempo, roda em paper trading a estratégia recomendada em `ACHADOS_estrategias_volume.md`: só short, cripto + ações, RR 1,5, timeout de 24h, custo ≤ 0,15% e ½ Kelly.

```
cd paper
node src/main.js          # dashboard em http://localhost:4002
npm test                  # paridade com o motor Python do backtest (40 trades reais)
```

### Rodando permanente (pm2)

O app roda sob o pm2 (`ecosystem.config.cjs`), que o reinicia se cair. O `pm2-windows-startup` registra um `pm2 resurrect` no logon do Windows (chave `HKCU\...\Run\PM2`).

```
pm2 list                      # status
pm2 logs lighter-paper        # log ao vivo (arquivos em data/logs/)
pm2 restart lighter-paper     # depois de mudar código ou config.json
pm2 stop lighter-paper        # parar
pm2 save                      # depois de mudar a lista de processos
```

Reiniciar cancela os setups pendentes (as posições são retomadas), então evite reiniciar perto de um sinal.

Precisa de Node ≥ 22 (WebSocket e fetch nativos) e não tem dependências npm.

## O que faz

| parte | detalhe |
|---|---|
| **Gravador** (`src/recorder.js`) | WebSocket `order_book/*` de todos os perps (snapshot + deltas, com verificação de nonce). |
| | A cada 15s grava `data/book/<dia>/metrics.csv`: bid, ask, spread, custo por perna para US$1k/5k/20k (meio spread + slippage, mesma conta do `measure_spreads.py`) e profundidade a 0,5% e 1%. |
| | Ativos **quentes** (candidatos a sinal, setups e posições) passam a ser gravados a cada 1s, por 4h. |
| | `depth.jsonl` guarda os 25 níveis de cada lado: a cada 5 min, a cada 15s nos quentes e nos eventos (sinal, entrada, saída). |
| | `trades.csv` guarda todos os negócios. |
| | Na virada do dia, os arquivos do dia anterior são comprimidos em `.gz`. |
| **Sinal** (`src/bars.js`, `src/strategy.js`) | No fechamento de cada barra de 15m, baixa os candles REST de todos os perps (a mesma fonte do backtest) e calcula corpo/ATR14, volume/média de 1d e liquidez de 7d. |
| | Escolhe o top 1 por corpo e opera se a barra for de alta, a classe for cripto/ações, o ativo estiver livre e o custo no livro, para o tamanho da ordem, for ≤ 0,15%. |
| **Execução** | Barras e gatilho ao vivo, montados pelos negócios do WebSocket. |
| | O setup e as saídas replicam `search_fade_exec.engine`, conferido por `test/parity.test.js` (sinal, gatilho, stop, alvo, motivo e barra de saída idênticos ao Python). |
| **Tamanho** (`src/kelly.js`) | f* = argmax E[log(1 + f·R)] sobre os R líquidos do backtest (`data/kelly_prior.json`, n = 1198 com liq ≥ 500k, f* ≈ 9,7%) mais os R reais do paper. |
| | Risco por trade = ½ f* ≈ 4,8% do capital. |
| | Limites: 6% por trade, 25% de risco aberto somado, 3× de alavancagem por trade e 6× bruta. |
| **Dashboard** (`src/server.js`, `public/index.html`) | Porta 4002, atualizado por SSE a cada 2s. |

## Segunda estratégia: momentum 14d ajustado por vol (`src/momentum.js`)

Vem de `ACHADOS_estrategias_volume.md`, seção 9.1. Tem capital próprio (US$10k) e aba própria no dashboard.

| parte | detalhe |
|---|---|
| **Universo** | Perps cripto com liquidez ≥ US$500k/dia (média de 7d). |
| **Histórico** | Candles REST de 37 dias, só cripto, em `data/bars_mom/`, atualizados no rebalanceamento. |
| **Meta do dia** | Na barra que fecha às 0h UTC: chave = retorno 14d ÷ vol 30d (desvio dos log-retornos 15m × √96). Compra os 3 maiores e vende os 3 menores, ±1/6 do bruto cada. |
| **Carteira** | Média das metas dos últimos 7 dias (holding 7d sobreposto). Na primeira execução, as 6 metas anteriores são reconstruídas pelo histórico. |
| **Tamanho** | Alavancagem bruta = ½ Kelly sobre os retornos diários líquidos do backtest (`data/momentum_prior.json`, f* ≈ 6,9×), com teto de 3× (`config.momentum.maxGrossLeverage`). |
| **Execução** | Cada ativo é levado ao alvo varrendo o livro gravado. Ativos sem livro ficam adiados e são tentados de novo a cada minuto. Se o app estiver parado às 0h, o rebalanceamento acontece no reinício (marcado como atrasado). |
| **Teórico** | Retorno de fechamento a fechamento das barras de rebalanceamento, menos o giro × custo medido no livro, mais o funding horário. |
| **Real** | Preços das varreduras no livro e funding horário (`market_stats`). |

Arquivos em `data/momentum/`:
- `state.json`: posições, caixa, metas, curva e retornos diários;
- `rebalances.csv`: um rebalanceamento por linha;
- `fills.csv`: cada execução no livro, com preço, mid e slippage.

Paridade com o Python: `npm run test:momentum` baixa o histórico e confere elegíveis, retorno, vol, liquidez, chave e carteira contra `test/momentum_cases.json` (gerado por `scripts/export_momentum_prior.py`). Precisa de rede.

## Dois resultados por trade

- **Teórico**: os preços do backtest (gatilho, stop, alvo), menos o custo medido no livro no momento do sinal × pernas, mais o funding. Deve reproduzir o backtest (+0,15R).
- **Real**: entrada e stop/timeout executados varrendo o livro naquele instante (ordem a mercado). O alvo é uma ordem limite, sem custo. O funding vem dos pagamentos horários (`market_stats`). **O capital do paper evolui pelo resultado real.**

A diferença entre os dois é justamente o que se quer medir: o custo real nos momentos de pico de volume.

## Arquivos em `data/`

| arquivo | conteúdo |
|---|---|
| `state.json` | capital, setups, posições, trades e curva de capital (retomado ao reiniciar) |
| `signals.csv` | todo sinal top 1: medidas, custo no livro (US$1k e tamanho da ordem), custo típico de 24h e decisão/motivo |
| `trades.csv` | cada trade: preços teóricos e reais, slippage, funding, R teórico/real e capital |
| `book/<dia>/` | gravações do livro (`metrics.csv`, `depth.jsonl`, `trades.csv`) |
| `bars/<ATIVO>.json` | cache de candles 15m (900 barras) |
| `kelly_prior.json` | R do backtest, gerado por `scripts/export_kelly_prior.py` |

## Notas

- **Reinício**: setups pendentes são cancelados. Posições abertas são avançadas pelos candles REST do período parado e depois seguem ao vivo.
- **Sinal ~10–90s depois da virada**: é o tempo de baixar os candles REST. Não afeta a entrada, que só pode acontecer depois de um contra-candle fechado (barra k+1 ou mais tarde).
- **Alvo**: conta como executado quando o preço toca o alvo, como no backtest. Na prática, uma ordem limite pode precisar que o preço passe do alvo (fila).
- **Configuração**: `config.json` (filtros, classes, lados, tamanho e intervalos do gravador).
