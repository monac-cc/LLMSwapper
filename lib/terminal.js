'use strict';
/**
 * Abrir una terminal VISIBLE corriendo `claude setup-token`.
 *
 * El flujo de alta empieza fuera del panel: hay que buscar una terminal, escribir el comando,
 * aprobar en el navegador y volver a pegar. Esto se lleva el primer paso, que es el único que el
 * panel puede quitar de en medio; el resto lo hace Anthropic y lo hace el usuario.
 *
 * La ventana tiene que SOBREVIVIR al comando. `setup-token` imprime el token una vez y no lo
 * guarda en ningún sitio, así que una terminal que se cierre al terminar lo tira a la basura -
 * de ahí el `/k` en Windows y el `read` en Linux. Es el detalle que decide si esto sirve.
 *
 * Nada de lo que entra por HTTP llega hasta aquí: el comando es una constante y se pasa como
 * argv, nunca como una cadena que un shell tenga que volver a interpretar.
 */
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const CLI = 'claude';
const ARG = 'setup-token';

/** ¿Está `claude` en el PATH que ve este proceso? Sin él, abrir una terminal solo enseña un error. */
const claudeInstalled = () => existeEnPath(CLI);

// Emuladores de terminal de Linux, en orden de preferencia. gnome-terminal dejó de aceptar -e
// hace años y quiere `--`, así que cada uno lleva su propia forma de recibir el comando.
const LINUX_TERMINALS = [
  { bin: 'x-terminal-emulator', args: (sh) => ['-e', 'bash', '-lc', sh] },
  { bin: 'gnome-terminal', args: (sh) => ['--', 'bash', '-lc', sh] },
  { bin: 'konsole', args: (sh) => ['-e', 'bash', '-lc', sh] },
  { bin: 'xfce4-terminal', args: (sh) => ['-e', `bash -lc ${JSON.stringify(sh)}`] },
  { bin: 'alacritty', args: (sh) => ['-e', 'bash', '-lc', sh] },
  { bin: 'kitty', args: (sh) => ['bash', '-lc', sh] },
  { bin: 'xterm', args: (sh) => ['-e', 'bash', '-lc', sh] },
];

// where.exe se dirige por ruta absoluta, como wsl.exe en targets.js: el PATH que ve un Node
// lanzado desde una tarea o un contenedor no siempre incluye System32.
const WHERE = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
  : 'which';

function existeEnPath(bin) {
  try {
    execFileSync(WHERE, [bin], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lanza la terminal. Devuelve una etiqueta de CÓMO se abrió, para que el panel pueda decirlo:
 * "no pasa nada" y "abrí algo y no sé el qué" se parecen demasiado en una interfaz.
 * Lanza excepción si en esta plataforma no hay forma de abrir ninguna.
 */
function openSetupToken() {
  const opts = { detached: true, stdio: 'ignore' };

  if (process.platform === 'win32') {
    // /k y no /c: con /c la ventana se cierra al acabar y el token se va con ella.
    const cmdline = `${CLI} ${ARG}`;
    // Windows Terminal si está: respeta el perfil del usuario y no abre una consola heredada.
    // Se comprueba ANTES de lanzar. spawn() no lanza cuando el binario no existe -emite 'error'
    // más tarde, ya con el hilo fuera-, así que un try/catch aquí nunca caía a cmd.exe: el panel
    // decía "abierto en Windows Terminal" y no se abría nada.
    if (existeEnPath('wt.exe')) {
      const child = spawn('wt.exe', ['cmd', '/k', cmdline], { ...opts, windowsHide: false });
      child.on('error', () => {});
      child.unref();
      return 'Windows Terminal';
    }
    // `start` necesita un título antes del comando, o toma el primer argumento entrecomillado
    // como título de la ventana y no ejecuta nada.
    const child = spawn('cmd.exe', ['/c', 'start', 'claude setup-token', 'cmd', '/k', cmdline],
      { ...opts, windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return 'cmd.exe';
  }

  if (process.platform === 'darwin') {
    // do script deja el shell vivo detrás del comando, así que el token se queda a la vista.
    const script = `tell application "Terminal" to do script "${CLI} ${ARG}"`;
    const child = spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], opts);
    child.on('error', () => {});
    child.unref();
    return 'Terminal.app';
  }

  // Linux: el shell se queda esperando una tecla, o la ventana se cerraría con el token dentro.
  const sh = `${CLI} ${ARG}; echo; read -r -p 'Copia el token y pulsa Enter para cerrar…'`;
  for (const term of LINUX_TERMINALS) {
    if (!existeEnPath(term.bin)) continue;
    const child = spawn(term.bin, term.args(sh), opts);
    child.on('error', () => {});
    child.unref();
    return term.bin;
  }
  throw new Error('No encontré ningún emulador de terminal en este sistema');
}

module.exports = { claudeInstalled, openSetupToken, existeEnPath, LINUX_TERMINALS };

if (require.main === module) {
  const assert = require('node:assert');
  // Sin abrir nada: solo que la deteccion no lanza y que la tabla de Linux esta bien formada.
  assert.strictEqual(typeof claudeInstalled(), 'boolean');
  // La comprobación de PATH decide entre wt.exe y cmd.exe: tiene que distinguir de verdad.
  assert.strictEqual(existeEnPath('llmswapper-no-such-binary-xyz'), false);
  // El PATH de un proceso hijo puede no llevar el directorio de node (un runner, una tarea); se
  // añade solo para la comprobación, que es de existeEnPath y no del entorno.
  const savedPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath) + path.delimiter + savedPath;
  try {
    assert.strictEqual(existeEnPath(path.basename(process.execPath)), true, 'el propio node tiene que encontrarse');
  } finally {
    process.env.PATH = savedPath;
  }
  for (const t of LINUX_TERMINALS) {
    assert.ok(t.bin && typeof t.args === 'function');
    const argv = t.args('echo hola');
    assert.ok(Array.isArray(argv) && argv.length >= 1, `${t.bin} debe producir argv`);
    assert.ok(argv.every((a) => typeof a === 'string'), `${t.bin}: todo argv debe ser string`);
  }
  console.log(`terminal.js self-check OK (claude ${claudeInstalled() ? 'encontrado' : 'no encontrado'})`);
}
