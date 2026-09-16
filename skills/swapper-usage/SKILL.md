---
name: swapper-usage
description: Muestra todas las cuentas de Claude guardadas en LLMSwapper y el uso disponible de cada una (sesión de 5h y semana de 7d), marcando cuál está activa. Úsala cuando el usuario escriba /swapper-usage o pregunte cuánto le queda a sus cuentas o a cuál conviene cambiar.
---

# /swapper-usage

Lista todas las cuentas y su uso disponible, leyéndolo del panel LLMSwapper que corre en local.

## Qué hacer

Ejecuta con la herramienta Bash el CLI que viene junto a este SKILL.md:

```
node "<directorio de esta skill>/swapper.mjs" usage
```

`<directorio de esta skill>` es la carpeta donde está este archivo (la misma donde está `swapper.mjs`). Usa su ruta absoluta.

Muestra la salida del comando tal cual: ya viene formateada, una línea por cuenta (cuenta · sesión 5h · semana 7d · estado), con `●` en la cuenta en uso, `→` en la más libre para cambiar, y `casi`/`tope` en las que rondan o alcanzan el límite.

## Si falla

- "No llego al panel…": el servidor no está corriendo. Dile al usuario que ejecute `node server.js` en la carpeta de LLMSwapper (abre http://127.0.0.1:7373). Si usa otro puerto, exporta `PORT` antes del comando.
- No inventes cifras de uso: si el CLI no las da, repórtalo como lo diga el CLI.

No modifica nada; es solo lectura.
