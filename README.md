# Fraseado gratuito: Render Free + Groq Free

Este é um pacote **preparado para implantação**, não um aplicativo já publicado ou aprovado pelo ChatGPT.
Ele reaproveita a interface MCP com edição/cópia/exportação (TXT/MD), OAuth pessoal e conversão de MP3/MP4 em trechos via FFmpeg. A transcrição usa a **cota gratuita do Groq**, com `whisper-large-v3` e idioma `pt`. Não usa a API paga da OpenAI.

## Custos e limites

- **Render Free**: serviço sem mensalidade; desliga após 15 min ocioso, leva aproximadamente 1 minuto para acordar. Arquivos temporários desaparecem ao reiniciar e limites de utilização se aplicam. Sem meio de pagamento cadastrado, a plataforma pode suspender o serviço ao esgotar a cota, em vez de cobrar.
- **Groq Free**: limite de 25 MB por requisição, limite diário/horário de áudio e de requisições, sujeitos a mudanças. O aplicativo converte MP3/MP4 para MP3 mono 16 kHz em trechos de 10 min antes de enviar ao Groq. O tamanho total permitido pelo Fraseado é limitado a 50 MB por padrão, configurável. A soma do áudio não pode exceder a cota gratuita disponível.
- **Precisão de 98%**: não garantida por nenhum modelo. É preciso avaliar com transcrição de referência. Não confunda funcionamento dos testes de software com taxa de acerto da fala.
- **Privacidade**: os arquivos são transferidos temporariamente do ChatGPT para o servidor Render e do servidor para a API Groq. Não envie gravações sensíveis sem avaliar termos, consentimento e políticas de tratamento de dados. Não há histórico persistente.

## Publicação do servidor MCP

1. Conecte a hospedagem **Render** no ChatGPT para permitir as operações assistidas de implantação, ou use o painel <https://dashboard.render.com/> com o código deste projeto em um repositório Git.
2. Crie uma conta gratuita no **Groq** (<https://console.groq.com/>) e, no painel, gere uma chave de API do plano Free. Não envie a chave na conversa.
3. Crie um serviço **Web Service / Free** no Render a partir deste repositório, usando o `Dockerfile`, ou crie um Blueprint pelo `render.yaml`. Confirme que a opção Free está selecionada. Evite adicionar uma forma de pagamento se não quiser risco de cobrança por excedentes.
4. Configure os segredos no Render, em Environment: `GROQ_API_KEY`, `FRASEADO_LOGIN_PASSWORD` (16+ caracteres) e `AUTH_JWT_SECRET` (32+ caracteres, gerado automaticamente no Blueprint). O Render pode disponibilizar `RENDER_EXTERNAL_URL`; se não disponibilizar, configure `PUBLIC_ORIGIN` com a URL pública HTTPS correta. Ela é obrigatória para o OAuth.
5. Aguarde o **deploy com status Live** e verifique `https://SEU-SERVICO.onrender.com/health`. A resposta incluirá `"ok":true` e `"transcriptionReady":false` até a configuração de `GROQ_API_KEY`. A transcrição só funcionará depois disso.
6. Valide o OAuth, o endpoint MCP e um arquivo real de MP3/MP4. Em `ChatGPT (web) → Plugins → + → Add custom MCP server`, informe `https://SEU-SERVICO.onrender.com/mcp`, escolha OAuth e conclua a autorização com a senha pessoal do Fraseado. Depois instale o plugin e teste com `@Fraseado`.
7. Se o Render estiver adormecido, a primeira chamada pode demorar cerca de um minuto ou falhar por timeout. Tente a conexão novamente quando o servidor estiver acordado.

## Execução local

Requisitos: Node.js 22+, npm, FFmpeg. Para testar, use segredos de desenvolvimento nas variáveis de ambiente e `PUBLIC_ORIGIN` apontando para uma URL HTTPS que chegue ao servidor (ex. túnel seguro). `npm install && npm test && npm start`. Não abra o servidor de produção com senhas de teste.

## Segurança e limitações atuais

Este é um protótipo **pessoal**, de usuário único, com OAuth por senha, sem provedor externo de identidade. Os códigos de autorização ficam na memória e podem se perder em reinicializações. A integração ponta-a-ponta no ChatGPT ainda precisa ser validada após a publicação. A URL temporária do arquivo recebido do ChatGPT é limitada a domínios autorizados no servidor.

Fontes para conferir condições e detalhes atualizados:
- <https://render.com/docs/free>
- <https://render.com/docs/blueprint-spec>
- <https://console.groq.com/docs/speech-to-text>
- <https://console.groq.com/docs/rate-limits>
- <https://developers.openai.com/api/docs/guides/custom-mcp-server>
