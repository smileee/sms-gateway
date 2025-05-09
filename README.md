# Sendeasy SMS Gateway

## 1. Visão Geral

O Sendeasy SMS Gateway é uma aplicação Node.js projetada para enviar e receber mensagens SMS utilizando um modem GSM conectado a um dispositivo, como um Raspberry Pi. Ele fornece uma API REST para enfileirar mensagens para envio (outbound) e um mecanismo para processar SMS recebidos (inbound), encaminhando-os para um webhook configurado.

O sistema utiliza uma fila persistente baseada em LowDB para gerenciar o envio de mensagens, suportando prioridades e garantindo que as mensagens não sejam perdidas em caso de reinício da aplicação.

**Tecnologias Principais:**
*   Node.js
*   Express.js (API REST)
*   node-serialport (Comunicação com modem GSM)
*   LowDB (Banco de dados JSON para fila e histórico)
*   Axios (Para chamadas de webhook)
*   Winston (Logging)

## 2. Funcionalidades

*   Envio de SMS individuais e em massa via API REST.
*   Recebimento de SMS do modem.
*   Processamento de SMS inbound com encaminhamento para um webhook configurável.
*   Fila de mensagens persistente com prioridades (Inbound > Outbound Individual > Outbound Bulk).
*   Decodificação de mensagens UCS-2 (para caracteres especiais e emojis) tanto para inbound quanto para outbound.
*   Autenticação baseada em token para os endpoints da API.
*   Logging detalhado das operações.
*   Configuração flexível via variáveis de ambiente e arquivo de configuração.

## 3. Arquitetura

O projeto é modularizado para facilitar a manutenção e escalabilidade:

*   `src/`
    *   `server/`: Contém o servidor Express.js, define os endpoints da API e inicializa a escuta de SMS inbound.
    *   `config/`: Gerencia as configurações da aplicação (porta, serial, timeouts, URLs) e a lógica da fila de mensagens (`queue.js`).
    *   `modem/`: Abstrai a comunicação com o modem GSM, incluindo a abertura da porta serial (`serial.js`) e o envio de comandos AT (`commands.js`).
    *   `sms/`: Contém a lógica específica para SMS:
        *   `inboundProcessor.js`: Processa SMS recebidos, decodifica e envia para webhooks.
        *   `outboundProcessor.js`: Formata e envia SMS para o modem.
        *   `encoding.js`: Lida com a detecção de necessidade e codificação para UCS-2.
    *   `db/`: Configura a instância do LowDB e define o schema padrão.
    *   `utils/`: Utilitários, principalmente o logger (Winston).
*   `data/`: (Criado em runtime) Armazena o arquivo `db.json` do LowDB.
*   `logs/`: (Criado em runtime) Armazena os arquivos de log da aplicação.

## 4. Pré-requisitos

### Hardware:
*   Raspberry Pi (qualquer modelo com porta USB, Pi 3B+ ou mais recente recomendado).
*   Modem GSM USB (ex: Huawei E3372, SIM800L com adaptador USB-Serial, etc.) com antena.
*   SIM Card com plano de dados/SMS ativo e compatível com a rede local.
*   Fonte de alimentação adequada para o Raspberry Pi e o modem (alguns modems consomem bastante energia).
*   Cabo USB para conectar o modem ao Raspberry Pi.

### Software:
*   Sistema Operacional no Raspberry Pi (Raspberry Pi OS Lite ou Desktop).
*   Node.js (versão 14.x ou superior recomendada).
*   npm (geralmente instalado com Node.js) ou Yarn.
*   Git (para clonar o repositório).

## 5. Instalação e Configuração no Raspberry Pi

1.  **Acesso ao Raspberry Pi:**
    Conecte-se ao seu Raspberry Pi via SSH ou diretamente com teclado/monitor.

2.  **Instalar Node.js e Git (se não instalados):**
    ```bash
    sudo apt update
    sudo apt install -y nodejs npm git
    # Para versões mais recentes do Node.js, considere usar NVM (Node Version Manager)
    # curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
    # source ~/.bashrc
    # nvm install --lts
    ```
    Se preferir Yarn:
    ```bash
    sudo npm install -g yarn
    ```

3.  **Clonar o Repositório (Exemplo):**
    (A Sendeasy fornecerá o método para obter o código, ex: acesso a um repositório Git privado)
    ```bash
    git clone <URL_DO_REPOSITORIO_SENDEASY> sms-gateway
    cd sms-gateway
    ```

4.  **Instalar Dependências:**
    Usando npm:
    ```bash
    npm install
    ```
    Ou usando Yarn:
    ```bash
    yarn install
    ```
    Isso instalará pacotes como `express`, `serialport`, `lowdb`, `axios`, `winston`, etc., definidos no `package.json`.

5.  **Configuração do Modem GSM:**
    *   Conecte o modem GSM à porta USB do Raspberry Pi.
    *   Identifique a porta serial do modem. Geralmente é algo como `/dev/ttyUSB0`, `/dev/ttyUSB1`, etc. Você pode tentar identificá-la com:
        ```bash
        dmesg | grep tty
        ```
        Procure por mensagens recentes relacionadas a "GSM Modem" ou "cdc_acm".

6.  **Configurar Variáveis de Ambiente:**
    Crie um arquivo `.env` na raiz do projeto (`sms-gateway/.env`):
    ```env
    # Porta para o servidor da API
    PORT=3000

    # Token de autenticação para a API (mude para um valor seguro)
    AUTH_TOKEN="sendeasy-sms-token-CHANGE-ME"

    # Configurações da Porta Serial do Modem
    SERIAL_PORT="/dev/ttyUSB0" # Ajuste conforme identificado
    BAUD_RATE=115200 # Comum para muitos modems, mas verifique o manual do seu

    # Nível de Log (error, warn, info, debug)
    LOG_LEVEL="info"

    # --- Configurações Inbound (Hardcoded em src/config/index.js por enquanto) ---
    # Para habilitar/desabilitar inbound e configurar webhook via .env no futuro:
    # INBOUND_ENABLED=true
    # WEBHOOK_URL="https://seu-endpoint.com/webhook/incoming-sms"

    # --- Timeouts (Padrões em src/config/index.js, podem ser sobrescritos aqui) ---
    # PROMPT_TIMEOUT=500
    # SMS_TIMEOUT=1500
    # MODEM_BOOT_DELAY=1000
    # AT_COMMAND_TIMEOUT=500
    ```
    **Nota:** As configurações de `inbound.enabled` e `inbound.webhookUrl` estão atualmente hardcoded em `src/config/index.js`. Para alterá-las, modifique diretamente esse arquivo por enquanto.

7.  **Permissões da Porta Serial:**
    O usuário que executa a aplicação Node.js precisa de permissão para acessar a porta serial. Adicione o usuário ao grupo `dialout` (ou `tty` dependendo da distribuição):
    ```bash
    sudo usermod -a -G dialout $USER
    ```
    Você precisará fazer logout e login novamente (ou reiniciar o Pi) para que a mudança de grupo tenha efeito.

## 6. Executando a Aplicação

### Para Desenvolvimento/Teste:
```bash
# Usando npm
npm start

# Ou usando Yarn
yarn start

# Ou diretamente com Node
node src/server/index.js

# Para logs mais detalhados (debug)
LOG_LEVEL=debug node src/server/index.js
```

### Para Produção:
É altamente recomendável usar um gerenciador de processos como o PM2 para manter a aplicação rodando em background, reiniciá-la em caso de falhas e gerenciar logs.

1.  **Instalar PM2 (globalmente):**
    ```bash
    sudo npm install pm2 -g
    ```
2.  **Iniciar a Aplicação com PM2:**
    Navegue até o diretório raiz do projeto (`sms-gateway`) e execute:
    ```bash
    pm2 start src/server/index.js --name "sms-gateway" --env .env
    ```
    (O `--env .env` pode não ser necessário se as variáveis de ambiente já estiverem carregadas no shell ou se o `dotenv` no código for suficiente).
    Para carregar variáveis do `.env` com PM2, você pode precisar de um arquivo de ecossistema (`ecosystem.config.js`).

3.  **Comandos Úteis do PM2:**
    *   `pm2 list`: Lista todas as aplicações gerenciadas.
    *   `pm2 logs sms-gateway`: Mostra os logs em tempo real.
    *   `pm2 stop sms-gateway`: Para a aplicação.
    *   `pm2 restart sms-gateway`: Reinicia a aplicação.
    *   `pm2 delete sms-gateway`: Remove a aplicação do PM2.
    *   `pm2 startup`: Gera um comando para fazer o PM2 iniciar automaticamente no boot do sistema.

## 7. API Endpoints

Todos os endpoints requerem o header `x-auth-token` com o valor definido em `AUTH_TOKEN`.

*   **`POST /sms`**: Envia uma única mensagem SMS.
    *   Body: `{ "number": "+1234567890", "message": "Hello World" }`
    *   Resposta (Sucesso): `{ "ok": true, "id": "msg-..." }`
*   **`POST /bulk-sms`**: Envia múltiplas mensagens.
    *   Body: `{ "messages": [{ "number": "...", "message": "..." }, ...] }`
    *   Resposta (Sucesso): `{ "ok": true, "queued": <count> }`
*   **`GET /queue`**: Lista mensagens na fila de envio.
*   **`GET /sent`**: Lista mensagens enviadas com sucesso (incluindo inbound processadas).
*   **`DELETE /queue`**: Limpa a fila de mensagens pendentes.
*   **`DELETE /sent`**: Limpa o histórico de mensagens enviadas/processadas.

## 8. Fluxo de Mensagens Inbound

Se `config.inbound.enabled` for `true` (atualmente hardcoded em `src/config/index.js`):
1.  Na inicialização, o modem é configurado com `AT+CNMI=2,1,0,0,0` para notificar a aplicação sobre novos SMS.
2.  Quando um SMS chega, o modem envia um URC (Unsolicited Result Code) como `+CMTI: "SM",<index>`.
3.  O `SerialManager` detecta esse URC e chama `smsQueue.handleIncomingSMSEvent(<index>, <memory>)`.
4.  `handleIncomingSMSEvent` em `queue.js` faz o seguinte:
    *   Lê a mensagem bruta do modem usando `atManager.readSMS(<index>)`.
    *   Deleta a mensagem do SIM card do modem usando `atManager.deleteSMS(<index>)` para evitar que o SIM encha.
    *   Adiciona a mensagem à fila (`queue`) do LowDB com `type: 'inbound'`, `status: 'received_raw'`, e prioridade `INBOUND_HIGH`.
5.  O loop `process()` da `SMSQueue` pega essa mensagem.
6.  A mensagem é delegada para `inboundProcessor.processReceivedSMS(message)`.
7.  `inboundProcessor.js`:
    *   Parseia a mensagem bruta (incluindo decodificação de UCS-2 hexadecimal se necessário).
    *   Monta um payload JSON.
    *   Envia o payload via POST para a URL definida em `config.inbound.webhookUrl`.
    *   **Payload do Webhook (Exemplo):**
        ```json
        {
          "id": "in-1746805645643-cfkl", // ID interno do gateway
          "from": "+17743010298",       // Número do remetente
          "text": "PING",               // Conteúdo da mensagem decodificado
          "modemTimestamp": "25/05/09,08:47:23-28", // Timestamp do modem
          "gatewayReceivedAt": "2025-05-09T11:47:24.976Z", // Quando o gateway recebeu o evento +CMTI
          "originalIndex": 11,           // Índice original no modem
          "modemMemory": "SM"            // Memória do modem onde foi recebido
        }
        ```
    *   Se o webhook responder com sucesso (2xx), a mensagem é movida da `queue` para a coleção `sent` com status `webhook_sent_ok`.
    *   Se falhar, o status é atualizado para `webhook_send_failed`, e há uma lógica de retentativa (atualmente 3 tentativas). Após as retentativas, é movida para `failed_inbound`.

## 9. Estrutura do Banco de Dados (LowDB)

*   **Arquivo:** `data/db.json` (criado automaticamente na raiz do projeto se não existir).
*   **Coleções Principais:**
    *   `queue`: Armazena mensagens pendentes de envio (outbound) ou pendentes de processamento de webhook (inbound).
    *   `sent`: Armazena mensagens outbound enviadas com sucesso e mensagens inbound processadas com sucesso pelo webhook.
    *   `failed_inbound`: Armazena mensagens inbound que falharam no parse ou excederam as tentativas de envio ao webhook.
*   **Estrutura de um Item na `queue` (Exemplos):**
    *   **Outbound:**
        ```json
        {
          "number": "+1234567890",
          "message": "Olá mundo",
          "id": "msg-1700000000000-abc",
          "status": "pending", // ou "failed"
          "createdAt": "2025-05-09T12:00:00.000Z",
          "priority": "outbound-medium", // ou "outbound-low"
          "bulkIndex": 0, // para bulk
          "retries": 0,
          "error": "Mensagem de erro se falhou"
        }
        ```
    *   **Inbound (antes do processamento do webhook):**
        ```json
        {
          "id": "in-1700000000000-xyz",
          "type": "inbound",
          "originalIndex": 5,
          "modemMemory": "SM",
          "rawData": "+CMGR: \"REC UNREAD\",\"+sender\",\"\",\"timestamp\"...",
          "status": "received_raw", // ou "webhook_send_failed"
          "priority": "inbound-high",
          "createdAt": "2025-05-09T12:05:00.000Z",
          "retries": 0
        }
        ```

## 10. Logging

*   Os logs são gerenciados pelo Winston.
*   O nível de log pode ser configurado pela variável de ambiente `LOG_LEVEL`. Valores comuns: `error`, `warn`, `info`, `debug`.
*   Os logs são exibidos no console e também salvos em arquivos:
    *   `logs/error.log`: Apenas logs de erro.
    *   `logs/combined.log`: Todos os logs.

## 11. Diagnóstico e Troubleshooting

Para problemas de conectividade do modem ou envio/recebimento de SMS, utilize comandos AT diretamente via um terminal serial como `minicom`.

Conecte-se à porta serial do modem (ex: `/dev/ttyUSB0`) com a configuração de baudrate correta (ex: 115200 8N1).

### Comandos AT Essenciais:

1.  **`AT`**: Testa a comunicação. Resposta: `OK`.
2.  **`AT+CPIN?`**: Status do SIM. Resposta: `+CPIN: READY`.
3.  **`AT+CREG?`**: Registro na rede. Resposta ideal: `+CREG: 0,1` ou `+CREG: 0,5`.
4.  **`AT+CSQ`**: Qualidade do sinal. Resposta ideal: `+CSQ: <rssi>,<ber>` onde `rssi` > 10.
5.  **`AT+COPS?`**: Operadora atual.
6.  **`AT+CPMS?`**: Uso da memória de mensagens.
7.  **`AT+CMGF=1`**: Define modo texto. Resposta: `OK`.
8.  **`AT+CMGL="ALL"`**: Lista todas as mensagens no modem.
9.  **`AT+CMGR=<index>`**: Lê a mensagem no índice especificado.
10. **`AT+CMGD=1,4`**: Deleta TODAS as mensagens do SIM card.
11. **`AT+CNMI?`**: Verifica configuração de notificação de SMS. (Deve ser `2,1,0,0,0` para o nosso caso).
12. **`AT+CSCA?`**: Exibe o número do centro de mensagens (SMSC).

**Dicas Comuns:**
*   Verifique se a `SERIAL_PORT` no `.env` está correta.
*   Analise os logs em `logs/` e no console para mensagens de erro.
*   Certifique-se de que o SIM card tem crédito/plano ativo e bom sinal.
*   Verifique as permissões da porta serial para o usuário que executa o Node.js.

## 12. Desenvolvimento e Contribuições (Interno Sendeasy)

*   Siga a estrutura de pastas e a modularização existente.
*   Mantenha a separação de responsabilidades entre os módulos.
*   Documente novos endpoints ou mudanças significativas no fluxo.
*   Escreva logs claros e informativos.

## 13. Informações de Contato/Suporte

Para dúvidas ou problemas, contate a equipe de desenvolvimento Sendeasy responsável por este projeto.

---