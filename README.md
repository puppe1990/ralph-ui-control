# Ralph Control UI

UI em React para monitorar processos do Ralph/Codex e iniciar/parar execuções direto da interface.

## Recursos

- Ver processos ativos (`ralph_loop.sh`, `ralph --`, `codex exec`)
- Rodar Ralph em um projeto com argumentos customizados
- Parar processo por PID
- Visualizar `status.json`, `ralph.log` e `fix_plan.md`

## Uso

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001

## Observações

- Por padrão, o backend usa:
  - script: `/Users/matheuspuppe/Desktop/Projetos/github/ralph-codex/ralph_loop.sh`
- Para funcionar, o projeto alvo precisa ter `.ralph/` habilitado.
