#!/bin/bash
# reinicia lighter-paper uma vez quando nao houver setup armado (fade e C2) e o relogio estiver nos minutos 3-9 do slot de 15m (sem passos do JEV)
cd /root/lighter
N=/root/.nvm/versions/node/v24.21.0/bin/node
end=$(( $(date +%s) + 86400 ))
while [ $(date +%s) -lt $end ]; do
  m=$(( 10#$(date -u +%M) % 15 ))
  if [ $m -ge 3 ] && [ $m -le 9 ]; then
    n=$($N -e "const f=p=>Object.keys(JSON.parse(require(\"fs\").readFileSync(p)).setups||{}).length;console.log(f(\"data/state.json\")+f(\"data/fade_c2/state.json\"))")
    if [ "$n" = "0" ]; then
      echo "$(date -u) reiniciando (setups 0, minuto $m) - $1"; systemctl restart lighter-paper; exit 0
    fi
  fi
  sleep 30
done
echo "$(date -u) desistiu: setups armados por 24h - $1"
