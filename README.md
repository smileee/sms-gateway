# SIM7600 + Raspberry Pi Gateway
Gateway SMS com SIM7600X 4G HAT

## Requisitos de Hardware
- Raspberry Pi (4GB RAM+ recomendado) com Debian 12 / Bookworm
- Waveshare SIM7600X 4G HAT (ou SIM7600G-H)
- Chip 4G com suporte a SMS (Brasil ou EUA)
- Cabo USB para conexão com o HAT

## Instalação Rápida

1. Execute o script de instalação:
```bash
chmod +x install.sh
./install.sh
```

2. Instale as dependências do sistema:
```bash
sudo apt update && sudo apt install -y \
    python3-serial python3-fastapi python3-uvicorn \
    python3-requests sox lrzsz alsa-utils
```

3. Configure o ambiente:
```bash
echo "export PYTHONUNBUFFERED=1" >> ~/.bashrc
sudo systemctl mask --now ModemManager
sudo usermod -aG dialout $USER
newgrp dialout
```

## Configuração do Gateway

1. Configure as variáveis de ambiente (opcional):
```bash
# Porta serial do modem (padrão: /dev/ttyUSB3)
export SERIAL_PORT=/dev/ttyUSB3

# Baud rate (padrão: 115200)
export BAUD_RATE=115200

# Porta do servidor (padrão: 3000)
export PORT=3000
```

## Uso da API

O gateway oferece os seguintes endpoints:

### 1. Envio de SMS único
```bash
curl -X POST http://localhost:3000/sms \
  -H "Content-Type: application/json" \
  -d '{
    "number": "+5511999999999",
    "message": "Olá!"
  }'
```

### 2. Envio em massa (bulk)
```bash
curl -X POST http://localhost:3000/bulk-sms \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "number": "+5511999999999",
        "message": "Mensagem 1"
      },
      {
        "number": "+5511888888888",
        "message": "Mensagem 2"
      }
    ]
  }'
```

### 3. Consulta da fila de mensagens
```bash
curl http://localhost:3000/queue
```

### 4. Consulta de mensagens enviadas
```bash
curl http://localhost:3000/sent
```

### 5. Limpar fila de mensagens
```bash
curl -X DELETE http://localhost:3000/queue
```

### 6. Limpar histórico de enviados
```bash
curl -X DELETE http://localhost:3000/sent
```

## Limitações e Observações

- Mensagens GSM-7: máximo de 160 caracteres
- Mensagens UCS2 (Unicode): máximo de 70 caracteres
- O sistema detecta automaticamente se precisa usar UCS2
- Mensagens são enfileiradas e processadas sequencialmente
- O sistema mantém um histórico de mensagens enviadas
- Logs são salvos em `logs/combined.log` e `logs/error.log`

## Solução de Problemas

### 1. Se encontrar "Broken pipe" ao abrir /dev/ttyUSB0:
- Use ttyUSB2 ou ttyUSB3
- Verifique se o cabo está conectado corretamente

### 2. Se o modem não responder:
- Verifique se o chip está inserido corretamente
- Confirme se o chip tem saldo/cobertura
- Tente reiniciar o Raspberry Pi

### 3. Se as mensagens não forem enviadas:
- Verifique os logs em `logs/error.log`
- Confirme se o número está no formato internacional (+55...)
- Verifique se a mensagem não excede o limite de caracteres 