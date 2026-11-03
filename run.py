import os, subprocess, sys

os.environ.setdefault("MALLOC_ARENA_MAX", "1")

if not os.path.exists('.git'):
    REPO = 'https://{u}:{t}@github.com/S1lverElixir/a11-schedule-bot.git'.format(
        u=os.environ.get('USERNAME', ''), t=os.environ.get('ACCESS_TOKEN', ''))
    subprocess.run(['git', 'init'], check=True)
    subprocess.run(['git', 'remote', 'add', 'origin', REPO], check=True)
    subprocess.run(['git', 'fetch', '--depth', '1', 'origin', 'main'], check=True)
    subprocess.run(['git', 'reset', '--hard', 'FETCH_HEAD'], check=True)

# wheels в репозитории: pip в лимите 128 МБ падает по памяти при сетевой установке.
# Pip запускается только если пакетов ещё нет — экономит секунду и пик ~40 МБ на каждом рестарте
try:
    import aiohttp, dotenv  # noqa: F401
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '--no-index', '--find-links', 'wheels', '-r', 'requirements.txt'], check=True)
print('WHEELS-OK, starting bot', flush=True)


def rust_check():
    """Разовая проверка Rust-бинарника: две строки в консоль панели.

    Ничего не решает и не останавливает запуск: любая ошибка — просто строка в логе.
    Убрать вместе с переключением бота на Rust.
    """
    path = os.path.abspath('rust/bin/a11-bot')
    if not os.path.exists(path):
        print('RUST-CHECK: бинарника нет, пропуск', flush=True)
        return
    try:
        os.chmod(path, 0o755)
    except OSError as e:
        print(f'RUST-CHECK: chmod не удался: {e}', flush=True)
        return
    for args, title in ((['--selftest', '1'], 'RUST-SELFTEST'),
                        (['--check-net'], 'RUST-NET')):
        try:
            r = subprocess.run([path] + args, capture_output=True, text=True, timeout=30)
            out = (r.stdout or r.stderr).strip().replace('\n', ' | ')
            print(f'{title}: rc={r.returncode} {out[:300]}', flush=True)
        except Exception as e:  # noexec, таймаут, что угодно — бот всё равно должен стартовать
            print(f'{title}: ошибка {e.__class__.__name__}: {e}', flush=True)


rust_check()

os.execv(sys.executable, [sys.executable, '-X', 'utf8', 'bot.py'])
