# Rastreio do produto — Conty, desafio 07

API que cadastra um código em um agregador fictício por HTTP, sincroniza eventos e guarda o histórico em SQLite. A resposta expõe cinco estados estáveis e um alerta auditável de atraso. [Enunciado oficial](https://challenge.appconty.com/desafios/integracao-rastreio).

Node **22.23.3**, TypeScript estrito, Hono, `node:sqlite` e Vitest são escolhas deste projeto. O enunciado exige a API, a interface do cliente HTTP, testes, exemplo bruto/normalizado e explicação do atraso; não impõe essa stack. Não há repositório base para este desafio.

## Rodar

Instale Node 22.23.3 e confirme `node --version`. Não é preciso instalar SQLite à parte. `node:sqlite` emite um aviso de recurso experimental nesta versão do Node. O banco usa arquivo local e sobrevive a reinícios.

```sh
npm ci
npm run check
```

`check` executa typecheck, testes e build. Com o build pronto, abra dois terminais na raiz do repositório:

```sh
# Terminal 1: agregador fictício, porta 4000
npm run simulator
```

```sh
# Terminal 2: API, porta 3000
npm start
```

No Windows/PowerShell, use `npm.cmd` se a política de execução bloquear `npm.ps1`. Para desenvolver a API, use `npm run dev` com o simulador em outro terminal. Os servidores escutam em `127.0.0.1`.

## Fluxo completo

O simulador carrega [examples/raw-payload.json](examples/raw-payload.json) para `BR123`; outros códigos cadastrados retornam histórico vazio. O fixture demonstra uma entrega no prazo, mesmo quando consultada muitos dias depois. Não é uma transportadora real.

```sh
curl -i -X POST http://127.0.0.1:3000/trackings \
  -H 'Content-Type: application/json' \
  -d '{"tracking_code":"BR123","transit_limit_hours":120}'

curl -X POST http://127.0.0.1:3000/trackings/BR123/sync
curl http://127.0.0.1:3000/trackings/BR123
```

Equivalente em PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/trackings `
  -ContentType 'application/json' `
  -Body '{"tracking_code":"BR123","transit_limit_hours":120}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/trackings/BR123/sync
Invoke-RestMethod -Uri http://127.0.0.1:3000/trackings/BR123 | ConvertTo-Json -Depth 10
```

O cadastro retorna `201`; repetir o mesmo código retorna `200` com o recurso existente, preservando o limite original. O cadastro remoto é idempotente e acontece antes de gravar localmente: falha do agregador não cria rastreio local. Uma nova tentativa permite recuperar uma falha entre a confirmação remota e a gravação local.

| Endpoint | Resultado |
|---|---|
| `POST /trackings` | Cadastra; `tracking_code` obrigatório, limite opcional |
| `POST /trackings/:code/sync` | Consulta o agregador, persiste eventos, avalia atraso e retorna `new_events` |
| `GET /trackings/:code` | Lê histórico local e avalia atraso; não consulta o agregador |
| `GET /health` | `{"status":"ok"}` |

Código: 1–80 caracteres, letras, números, hífen ou sublinhado, começando por letra ou número; sensível a maiúsculas. Limite: horas positivas e finitas, equivalentes a pelo menos 1 ms e no máximo `Number.MAX_SAFE_INTEGER` ms. Não existe endpoint para mudar o limite depois do cadastro.

Erros são JSON: `{"error":{"code":"tracking_not_found","message":"Código de rastreio não cadastrado."}}`. Entrada inválida retorna `400`, código inexistente `404`, falha HTTP/conexão/payload do agregador `502` e timeout `504`. Um payload inválido rejeita o lote inteiro, sem salvar um prefixo válido. Cada operação HTTP tem timeout, inclusive a leitura do corpo; não há retry automático. Uma nova chamada a `/sync` reprocessa com deduplicação.

## Bruto → normalizado

O adaptador conhece o dialeto fictício:

| `status` do agregador | Estado normalizado |
|---|---|
| `POSTADO` | `posted` |
| `EM_TRANSITO` | `in_transit` |
| `SAIU_PARA_ENTREGA` | `out_for_delivery` |
| `ENTREGUE` | `delivered` |
| `EXCECAO` | `exception` |
| Qualquer outro valor não vazio | `unknown` apenas no histórico |

O reconhecimento remove espaços nas extremidades e ignora caixa; `raw_status` preserva o valor recebido. O agregador usa `code`, `events`, `status` e `timestamp`; só o adaptador e o simulador conhecem esse formato. Datas exigem ISO 8601 com fuso explícito e calendário válido e são convertidas para UTC; `location` é aparada ou `null`.

O fixture começa assim:

```json
{
  "code": "BR123",
  "events": [
    { "event_id": "br123-1", "status": "POSTADO", "timestamp": "2026-10-01T09:00:00-03:00", "location": "São Paulo" }
  ]
}
```

Para o **fixture completo**, o resultado principal é:

```json
{
  "tracking_code": "BR123",
  "current_status": "delivered",
  "tracking_state": "completed",
  "transit_started_at": "2026-10-01T12:00:00.000Z",
  "delivered_at": "2026-10-03T12:00:00.000Z",
  "elapsed_transit_ms": 172800000,
  "currently_delayed": false,
  "late_delivery": false,
  "alert": null
}
```

[examples/normalized-payload.json](examples/normalized-payload.json) contém essa projeção e o histórico normalizado. O teste de integração confere o arquivo contra a resposta real. A API também retorna `registered_at`, `transit_limit_hours`, `identity` e `received_at` para cada evento; `/sync` acrescenta `new_events`. Esses campos variáveis de cadastro/recepção foram omitidos do exemplo estático.

## Histórico e ordem

- Identidade por código: `id:<event_id>` quando presente; caso contrário, SHA-256 de um array JSON canônico `[tracking_code, raw_status, occurred_at_UTC, location_aparada_ou_null]`. Recepção não participa da identidade. O status bruto exato participa; dialetos diferentes sem ID podem representar eventos distintos.
- A chave única `(tracking_code, identity)` evita duplicatas no lote, em novas consultas e depois de reabrir o banco. A primeira versão de um ID vence, inclusive seu `received_at`; IDs do provedor devem ser estáveis, e retificações de um mesmo ID não são suportadas.
- `occurred_at` é a ocorrência na transportadora; `received_at` é o relógio local no sync. A ordem usa ocorrência, nunca recepção.
- Empates: `posted < in_transit < out_for_delivery < exception < delivered`. Dentro do mesmo estado/instante, a identidade desempata por ordem lexical. Fora do empate, o último estado reconhecido por ocorrência vence; `exception` pode voltar a trânsito após uma ocorrência mais recente.
- `delivered` é terminal: eventos de trânsito/exceção posteriores ficam no histórico e não reabrem o pacote. Havendo várias confirmações de entrega, a ocorrência mais antiga congela a duração. O histórico permanece ordenado por ocorrência, mesmo que o último item já não determine o estado terminal.
- `unknown` preserva evidência e não muda o último estado reconhecido. Sem nenhum evento reconhecido, `current_status: null` e `tracking_state: pending`. Os demais rastreios são `active` ou, se entregues, `completed`.

## Atraso e auditoria

O início é o menor `occurred_at` reconhecido como `posted` ou `in_transit`. Só desconhecidos, ou somente saída para entrega/entrega sem início, deixam a duração `null`; não se inventa um prazo nesses casos.

Aberto: `max(0, Clock.now() - início)`. Entregue: `max(0, entrega.occurred_at - início)`. A duração é recalculada com o histórico disponível; uma ocorrência anterior recebida depois pode corrigir o início ou a primeira entrega. **Só duração estritamente maior que o limite gera atraso**: igualdade é normal, 1 ms além é atraso.

`currently_delayed` é verdadeiro apenas para pacote aberto. `late_delivery` é verdadeiro apenas para entrega cuja duração passou do limite, mesmo se a primeira consulta já trouxer a entrega. Uma entrega normal continua normal ao ser consultada cinco dias depois. O relógio é injetado nos testes, não exposto como controle na API.

O atraso cria no máximo **um registro** na tabela `alerts`, com instante da detecção, início conhecido, duração, limite e base `open`/`delivered`. O registro preserva a observação original. Depois que a entrega é conhecida, `delivery_assessment` registra `confirmed_late` ou `invalidated_on_time`, com data, ocorrência e duração recalculada. Assim, uma confirmação recebida tarde de uma entrega feita no prazo invalida explicitamente o alerta aberto anterior, sem apagar a auditoria. Se outra evidência de início/entrega mudar essa conclusão, a avaliação é atualizada no mesmo registro. Leituras sem nova evidência não mudam a data dessa avaliação.

A avaliação acontece no sync e no GET. **Não há scheduler, notificação externa ou monitoramento automático.** GET pode persistir a primeira detecção ou reconciliar um alerta; isso é uma decisão deste projeto, não uma obrigação adicional do enunciado. Eventos e alerta do sync são gravados na mesma transação.

## Arquitetura e configuração

`app.ts` recebe os requests; `TrackingService` aplica as regras usando os contratos `TrackingProvider`, `Clock` e `TrackingRepository` de `domain.ts`. `HttpTrackingProvider` valida e traduz o dialeto externo. `SqliteTrackingRepository` persiste rastreios, eventos e alertas. `simulator.ts` fornece o agregador fictício, com cenários determinísticos e falhas configuradas pelos testes.

| Variável de ambiente | Padrão |
|---|---|
| `PORT` | `3000` |
| `DATABASE_PATH` | `./data/trackings.sqlite` |
| `PROVIDER_URL` | `http://127.0.0.1:4000` |
| `PROVIDER_TIMEOUT_MS` | `3000` |
| `TRANSIT_LIMIT_HOURS` | `120` |
| `SIMULATOR_PORT` | `4000` |

Execute da raiz do projeto. `DATABASE_PATH` é relativo ao diretório de execução, e seu diretório pai é criado automaticamente. Para mudar a porta do simulador, ajuste também `PROVIDER_URL` na API. Por exemplo, em PowerShell: `$env:TRANSIT_LIMIT_HOURS='48'; npm.cmd start`.

## Validação e limites

Validação local em **11/10/2026**, Node **22.23.3**: `npm ci` e `npm run check` passaram com **60 testes**, typecheck e build. A CI executa instalação limpa e os mesmos comandos no Linux com a mesma versão do Node.

Os dois executáveis compilados também foram iniciados e conferidos por HTTP: cadastro `201`, sync `200` com quatro eventos, entrega normal com duração de 48 horas, reinício da API preservando os quatro eventos e novo sync com `new_events: 0`.

Os testes cobrem cadastro/consulta por TCP real, todos os cinco estados, desconhecido, lote inválido atômico, falha HTTP, timeout/conexão, ID e fingerprint, reconsulta/reabertura de SQLite, ocorrência versus recepção, empates, entrega terminal, relógio controlado, igualdade/+1 ms, entrega normal/tardia no primeiro sync, limite por código e reconciliação do alerta. Os fixtures bruto e normalizado são comparados por teste.

Esta é uma demonstração local: sem frontend, autenticação, transportadora real, OAuth, retry automático, scheduler ou notificações. SQLite síncrono e leitura integral do histórico por rastreio atendem ao tamanho do desafio, não a uma operação de alto volume. Não há tratamento de retificações de IDs nem política de correção de dados pelo operador. Com mais tempo, essas escolhas precisariam de um contrato específico antes de produção.

## IA e revisão

Código, testes, exemplos e README foram produzidos com assistência de IA via Codex. A IA executou os testes e ferramentas acima e fez revisão do diff; subagentes de IA fizeram revisões independentes do núcleo e da fronteira HTTP. Foram corrigidos um erro de tipagem no encerramento dos servidores e a falta de reconciliação explícita de um alerta quando uma confirmação recebida depois comprova entrega no prazo. **Marco não fez revisão humana do código desta entrega.** Os testes são escritos neste projeto; não há suíte oficial oculta disponível nem integração com uma transportadora real validada.
