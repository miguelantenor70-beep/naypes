# Naypes — V1

Texas Hold'em entre amigos. Sem apostas de dinheiro: cada jogador entra com 1000 fichas, blinds 10/20, até 5 por mesa.

## Rodar no seu computador

```
npm install
npm start
```
Abra http://localhost:3000, crie uma sala e mande o link (`?sala=CODIGO`) para os amigos.
Para testar sozinho, abra a mesma sala em duas ou três abas (use nomes diferentes).

## Colocar no ar (para jogar de verdade com os amigos)

O jogo precisa de um servidor Node rodando, não funciona como site estático.
No Render (ou Railway/Fly):

1. Suba esta pasta para um repositório no GitHub.
2. Render → New → Web Service → escolha o repositório.
3. Build command: `npm install`  |  Start command: `npm start`
4. Depois do deploy, abra a URL, crie a sala e compartilhe o link.

Observações:
- No plano gratuito do Render o servidor "dorme" após alguns minutos sem uso e a primeira visita demora ~30s para acordar.
- O estado das salas fica na memória: se o servidor reiniciar, as mesas somem (as fichas voltam a 1000 numa sala nova).

## O que está pronto

- Texas Hold'em completo: blinds, pré-flop/flop/turn/river, aumento mínimo, all-in, side pots, empate com divisão do pote.
- Embaralhamento Fisher-Yates com `crypto.randomInt` (sem viés), feito no servidor.
- O servidor só envia a cada jogador as cartas dele; as dos outros só aparecem no showdown.
- Reconexão: se a aba fechar ou a internet cair, entrar de novo no mesmo link devolve o seu lugar.
- Jogador desconectado na sua vez: check automático ou desistência após 15s; na mão seguinte ele fica de fora até voltar.
- Quem fica sem fichas pode pegar mais 1000.
- A próxima mão começa sozinha depois do showdown.

## Fora da V1 (de propósito)

Contas e login, timer de jogada para quem está online, chat, rating, várias mesas por sala, blinds crescentes, histórico de mãos.

## Testes

```
npm test                 # motor: ranking de mãos, side pots, embaralhamento, 600 mãos aleatórias conferindo as fichas
node test/smoke.js       # servidor real + 3 clientes WebSocket jogando uma mão
```
