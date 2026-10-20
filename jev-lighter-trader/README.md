# jev-lighter-trader

Paper trading na Lighter com decisões do **JEV** (modelo "System One" da TypeSafe AI). Roda dentro do app `lighter-paper`, que já recebe os candles, o livro e o funding, e aparece na aba **JEV** do dashboard (:4002).

## A cada barra de 15 minutos

1. **Seleção:** ranking da força de tendência do conjunto curto (4h · 1d · 7d, a mesma métrica da aba Tendência), por |força|, entre os ativos com volume 24h ≥ US$500k. Entram os 5 primeiros com histórico suficiente para os indicadores.
2. **Estado enviado ao JEV:** força de tendência (score, z de cada horizonte, R², eficiência, posição no ranking), mercado (força do BTC, volume, volatilidade, spread, funding) e indicadores de **15m** e **4h** calculados em código: retornos, RSI(14), MACD, Bollinger, distância das EMAs 20/50/200, ADX e ±DI, ATR, posição no range, volume relativo e o formato do último candle. Os candles de 4h são agregados dos de 1h.
3. **Perguntas** (tipo `choice`):
   - sem posição: *"Given this data, which action has the highest profit potential: Long, Short or Skip?"*
   - com posição: *"Given this data, should I keep the position open or close it?"*. Vai junto a posição (lado, entrada, resultado, máximo a favor/contra, tempo).
4. **Execução:** primeiro todas as posições abertas são revistas; uma posição só fecha se a probabilidade de "close" passar de **65%**. Depois vêm as entradas: só abre se a probabilidade de long ou short passar de **65%**, começando pela maior. Um ativo fechado na barra não reabre na mesma barra. A ordem é a mercado, varrendo o livro gravado. Cada posição usa 25% do capital marcado, com no máximo 4 posições, e o capital inicial é de US$10.000. Posições abertas são revistas a cada barra, mesmo que o ativo saia do top 5. Em caso de erro da API, a posição é mantida e nada é aberto. O funding real entra no resultado.

## Arquivos

| arquivo | conteúdo |
|---|---|
| `.env` | `TYPESAFE_KEY=...` (não versionar) |
| `src/client.js` | chamada a `POST https://api.typesafe.ai/v1/systemone` com repetição em 408/429/5xx |
| `src/indicators.js` | indicadores e agregação 1h → 4h |
| `src/trader.js` | seleção, estado, perguntas, execução paper, funding e dados do dashboard |
| `test/trader.test.js` | testes (`node --test jev-lighter-trader/test/trader.test.js`) |

O estado fica em `data/jev/`: `state.json`, `decisions.csv` (cada resposta do JEV, com as probabilidades) e `trades.csv`. A configuração é o bloco `jev` do `config.json`, e `"enabled": false` desliga o módulo.

## Custo

O JEV cobra US$0,042 por milhão de tokens de entrada. Cada consulta tem uns 2.800 tokens, e são de 5 a 9 consultas por barra, o que dá cerca de US$0,06 a 0,10 por dia.
