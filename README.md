# Nano Banana MCP remoto

Servidor TypeScript para Cloudflare Workers, com MCP Streamable HTTP em `/mcp`, ferramentas `generate_image` e `edit_image`, OAuth obrigatório e integração REST oficial do Google Gemini. Funciona como **resource server OAuth**: o login, consentimento, PKCE e a emissão/renovação de tokens ficam em um provedor OAuth/OIDC externo configurado pelo administrador.

O projeto não cria contas, não habilita faturamento e não faz deploy automaticamente. As instruções de provisionamento abaixo devem ser executadas somente depois de autorizar esses recursos.

## Instalação e verificação local

Requer Node.js 22.22+ e npm.

```sh
npm ci
npm run check
```

`check` executa TypeScript, testes e `wrangler deploy --dry-run`. O último comando somente gera o bundle em `dist/`; não publica o Worker. O lockfile fixa as versões resolvidas. Para desenvolvimento, copie `.dev.vars.example` para `.dev.vars`, preencha os secrets localmente, ajuste as variáveis em `wrangler.jsonc` e execute `npm run dev`. Sem configuração válida, o servidor responde `503` e não chama o Gemini. Os testes usam chaves RSA efêmeras e respostas simuladas: não precisam de conta Cloudflare ou chave Gemini e não geram cobranças.

## Modelos e ferramentas

Modelos explicitamente permitidos, confirmados na documentação oficial em **5 de novembro de 2026**:

- `gemini-nano-banana-2.1` (padrão): Nano Banana 2.1; resoluções `1K`, `2K`, `4K`.
- `gemini-3.1-flash-image`: Nano Banana 2; `512px`, `1K`, `2K`, `4K`.
- `gemini-3-pro-image`: Nano Banana Pro; `1K`, `2K`, `4K`.
- `gemini-2.5-flash-image`: Nano Banana original; resolução nativa de aproximadamente `1K`, dependente da proporção. Não recebe uma opção de resolução artificial no pedido ao Google.

O catálogo é uma allowlist intencional. Nano Banana 2 Lite não está habilitado nesta versão. Disponibilidade, cotas e permissões continuam dependendo do projeto/chave do Google. Uma assinatura do aplicativo Gemini não fornece automaticamente acesso à API.

Proporções comuns: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. Os modelos 2.1 e 3.1 Flash Image também aceitam `1:4`, `4:1`, `1:8`, `8:1`. Combinações incompatíveis são recusadas antes da chamada ao Google. `4K` usa a resolução nativa correspondente à proporção, sem ampliação artificial.

Exemplo de argumentos para `generate_image`:

```json
{
  "prompt": "Uma banana de cerâmica azul, fotografia de produto",
  "model": "gemini-nano-banana-2.1",
  "aspect_ratio": "16:9",
  "resolution": "4K"
}
```

`edit_image` aceita os mesmos campos e exige `reference_images`:

```json
{
  "prompt": "Troque o fundo por uma praia e preserve a pessoa",
  "model": "gemini-3-pro-image",
  "resolution": "2K",
  "reference_images": [
    { "mime_type": "image/png", "data": "BASE64_DOS_BYTES_DA_IMAGEM" }
  ]
}
```

Substitua o marcador por base64 válido. São aceitos PNG, JPEG e WebP, com validação de assinatura e MIME. Não são aceitos URLs, caminhos locais ou data URIs. O cliente precisa fornecer os bytes: anexar uma foto na conversa não garante que o Claude consiga convertê-la automaticamente em argumentos base64. Esta versão não integra um serviço de upload ou acesso ao sistema de arquivos do cliente.

Os pedidos usam `POST https://generativelanguage.googleapis.com/v1beta/interactions`, cabeçalho `x-goog-api-key`, revisão `2026-05-20`, `store: false` e `response_format` com `type: image`, `aspect_ratio` e `image_size` quando aplicável. A resposta REST é lida de `steps[type=model_output].content`, convertida para conteúdo MCP. Blocos de pensamento são descartados. Cada edição é independente; não há histórico persistente de conversas.

## Entrega de imagens e R2 privado

Claude documenta aproximadamente 150 mil caracteres por resultado de ferramenta. O servidor reserva até 100 mil caracteres para imagens base64 inline e até 8 mil para texto. Imagens maiores, incluindo saídas 4K, são preservadas na resolução original em um bucket **R2 privado** e entregues por link de download com validade de **15 minutos**.

Esses links são credenciais temporárias específicas de leitura: contêm uma capacidade aleatória de 256 bits; somente seu SHA-256 é usado como chave do objeto. Qualquer pessoa que receba o link poderá baixar aquela imagem até a expiração. Eles não autorizam chamadas MCP ou geração. Não compartilhe links confidenciais. Não habilite domínio público nem acesso `r2.dev` ao bucket; desative logs de URLs de download em integrações adicionais. O Worker desabilita observabilidade e respostas usam `Cache-Control: no-store`.

O Worker verifica a expiração em cada download. Configure também uma regra de lifecycle no bucket para apagar objetos com prefixo `images/` depois de **1 dia**, para remover fisicamente os dados expirados. A expiração do link não apaga imediatamente o objeto; a regra de lifecycle faz a limpeza. A apresentação inline e a abertura de links podem variar entre clientes Claude.

## Autenticação OAuth e configuração do Claude

Todo acesso a `/mcp`, inclusive inicialização e listagem, exige `Authorization: Bearer <access_token>`. Não há modo anônimo ou chave Gemini enviada pelo cliente. Tokens em URL não são aceitos pelo MCP. O servidor valida assinatura **RS256**, `iss`, `aud`, `exp`, `nbf` quando presente, escopo `images:write` e allowlist de `sub`. Tokens opacos e ID tokens destinados a outro cliente não são aceitos. Os JWKS são obtidos de uma URL HTTPS fixa da configuração, nunca de campos do token.

As duas URLs públicas de descoberta são:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

Um pedido sem token recebe `401` com `WWW-Authenticate` apontando para os metadados RFC 9728, que anunciam o emissor OAuth externo e o escopo necessário. O Worker não implementa `/authorize`, `/token` ou cadastro de clientes; essas funções pertencem ao provedor. Nenhum login local incompleto é usado como substituto de OAuth.

Configure um provedor OAuth/OIDC com HTTPS, discovery público, Authorization Code + PKCE S256, consentimento e refresh tokens. Ele deve emitir access tokens com:

- `iss` exatamente igual a `OAUTH_ISSUER`, inclusive eventual barra final;
- `aud` contendo **a URL canônica completa do recurso**, por exemplo `https://nano-banana-mcp.seu-subdominio.workers.dev/mcp`;
- `scope` contendo `images:write` e um `sub` estável do usuário autorizado;
- assinatura RS256, chave publicada em `OAUTH_JWKS_URL` e expiração curta (por exemplo 5 minutos).

Use um provedor que suporte o parâmetro OAuth `resource` (RFC 8707) ou configure explicitamente a audiência desse recurso no cliente dedicado. Não use um token com audiência genérica de outra API. A descoberta do provedor deve oferecer OAuth Authorization Server Metadata ou OIDC discovery. Para identificar o cliente Claude, configure CIMD/DCR quando suportados ou use **seu próprio cliente OAuth pré-cadastrado**, informando client ID e, se aplicável, client secret na configuração do conector. O secret do cliente OAuth pertence ao provedor/Claude; não é necessário ao Worker.

### Exemplo de configuração com Keycloak existente

Este é um roteiro de configuração, não um provisionamento executado nem uma validação ponta a ponta de um tenant real:

1. Use um realm dedicado, acessível por HTTPS, com usuários restritos e MFA. Crie um cliente OIDC dedicado ao conector, com Standard Flow, client authentication e PKCE `S256`. Desabilite implicit flow, direct access grants e service accounts.
2. Cadastre o redirect URI exato `https://claude.ai/api/mcp/auth_callback`, compartilhado pelos clientes Claude Web, Desktop e mobile. Não use wildcard de redirect. Habilite consentimento e Authorization Code/refresh tokens.
3. Crie o client scope `images:write`, com inclusão no campo `scope` do access token, e associe-o ao cliente. Nesse cliente/scope, adicione um mapper **Audience** com **Included Custom Audience** igual a `https://SEU-WORKER/mcp` e inclusão no access token. Mantenha RS256. Use esse cliente apenas para este recurso.
4. Configure `OAUTH_ISSUER` como `https://SEU-KEYCLOAK/realms/SEU-REALM` e `OAUTH_JWKS_URL` como `https://SEU-KEYCLOAK/realms/SEU-REALM/protocol/openid-connect/certs`. A descoberta fica em `{issuer}/.well-known/openid-configuration`.
5. Identifique o `sub` real de cada usuário no access token emitido pelo provedor e grave somente os autorizados no secret `ALLOWED_SUBJECTS`, como um array JSON. Não use e-mail como substituto de `sub`.
6. No Claude Web/Desktop, vá a **Customize → Connectors → Add custom connector**, informe `https://SEU-WORKER/mcp`, escolha autenticação OAuth e **Use your own OAuth client**. Informe as credenciais do cliente dedicado na interface do Claude, autentique e conceda acesso. A conexão pertence à conta Claude e atende também o aplicativo móvel, conforme disponibilidade de conectores na conta.

A opção de cliente pré-cadastrado evita depender de DCR aberto. Outros provedores podem ser usados se satisfizerem o mesmo contrato. O fluxo de login/refresh real exige a configuração do provedor e um endpoint publicado; não foi executado nesta implementação sem deploy.

Remover um `sub` da allowlist revoga o acesso no próximo pedido após atualizar o secret. Revogar a sessão/refresh token no provedor impede novas emissões; um JWT já emitido pode permanecer válido até expirar. Não há introspecção por pedido. A emissão e a revogação das capacidades de download são independentes da sessão OAuth; a validade delas é limitada a 15 minutos.

## Implantação manual, depois de autorizada

1. Confirme as condições de uso e os custos da API Gemini e do R2/Workers. Não é necessário habilitar faturamento para testar o código local com mocks.
2. Ajuste `PUBLIC_URL`, `OAUTH_ISSUER`, `OAUTH_JWKS_URL` e `ALLOWED_ORIGINS` em `wrangler.jsonc`. `PUBLIC_URL` deve ser uma origem HTTPS sem caminho. Coloque o nome correto do bucket no binding `IMAGE_BUCKET`.
3. Com a conta Cloudflare correta, autentique-se e crie o bucket privado, caso ainda não exista:

   ```sh
   npx wrangler login
   npx wrangler r2 bucket create nano-banana-images
   ```

4. Pelo dashboard R2, configure a regra de lifecycle descrita acima. Não habilite publicação do bucket.
5. Insira os secrets por prompts do Wrangler, sem valores na linha de comando, código ou `wrangler.jsonc`:

   ```sh
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put ALLOWED_SUBJECTS
   ```

   `ALLOWED_SUBJECTS` recebe um array JSON dos identificadores autorizados. Uma lista vazia ou configuração ausente bloqueia todo o serviço com `503`. Restrinja a chave Gemini à API necessária no Google, quando disponível.

6. Execute `npm ci` e `npm run check`. Somente depois da revisão e autorização, publique com `npm run deploy`.
7. Verifique `GET /.well-known/oauth-protected-resource/mcp` (200) e `/mcp` sem token (401). Pelo conector do Claude ou MCP Inspector, complete OAuth, liste ferramentas, gere uma imagem pequena, gere 4K, baixe o arquivo e edite uma referência. Teste renovação de token, usuário não autorizado e expiração do download.

Secrets `.dev.vars` são somente locais e ignorados pelo Git. Não coloque chaves em mensagens, screenshots, commits ou exemplos. Não configure um proxy público que remova a validação OAuth. CORS permite apenas origens configuradas; clientes servidor a servidor, como a infraestrutura do Claude, podem não enviar `Origin`.

## Limites e erros

- Prompt: 1–8.000 caracteres após trim. Requisição JSON: até 16 MiB, inclusive corpos sem `Content-Length`.
- Referências: 1–14, até 4 MiB por imagem e 10 MiB combinados; limite conservador de 3 referências no modelo 2.5.
- Resposta JSON do Gemini: até 24 MiB; imagens retornadas: até 16 MiB combinados. Respostas maiores são recusadas, mesmo em 4K; nem todo arquivo 4K necessariamente caberá nesse limite.
- Timeout Gemini: 120 segundos. Não há repetição automática de chamadas que possam cobrar novamente.
- Rate limit: 5 execuções por usuário a cada 60 segundos, compartilhadas pelas duas ferramentas. O binding Cloudflare é local por localização e eventualmente consistente: é uma proteção contra abuso, não um teto financeiro global. Configure cotas do projeto Google antes do uso real.
- Falhas de autenticação usam HTTP 401/403; configuração incompleta 503; entradas HTTP inválidas 400/413/415. Erros durante ferramentas usam o resultado MCP `isError: true`, com mensagem sanitizada. Corpos de erro do provedor, secrets e prompts não são registrados.
- Se a geração concluir e o armazenamento/download falhar, a chamada Gemini pode já ter consumido cota. Não há garantia de execução única em novas tentativas do próprio cliente.
- Transporte sem sessões: respostas JSON de Streamable HTTP; `GET /mcp` e `DELETE /mcp` autenticados retornam 405. SSE permanente e transporte legado `/sse` não são oferecidos.

## Fontes oficiais consultadas

- [Cloudflare: servidor MCP remoto e Streamable HTTP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [autorização](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/) e [rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- [MCP: transportes](https://modelcontextprotocol.io/specification/latest/basic/transports) e [autorização, descoberta e resource indicators](https://modelcontextprotocol.io/specification/latest/basic/authorization). O SDK negocia as versões que suporta, incluindo as usadas pelo Claude; não se presume suporte a toda extensão da especificação mais recente.
- [Claude: construção de servidores, limites e resultados de imagem](https://claude.com/docs/connectors/building), [OAuth, PKCE, callback e cadastro de clientes](https://claude.com/docs/connectors/building/authentication), [conectores remotos nas diferentes aplicações](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- [Google: Nano Banana, modelos, edição, proporções e resolução](https://aistudio.google.com/docs/image-generation) e [contrato REST Interactions](https://aistudio.google.com/api-reference/interactions-api).
- [Keycloak: descoberta, tokens e JWKS](https://www.keycloak.org/securing-apps/oidc-layers) e [administração de clientes, scopes e audience mappers](https://www.keycloak.org/docs/latest/server_admin/index.html).
