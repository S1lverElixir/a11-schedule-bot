import os, subprocess, sys, shutil, tempfile

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


def rust_binary():
    """Копия бинарника с правом запуска — вне репозитория.

    Сам файл в репозитории трогать нельзя: chmod меняет режим в git, и следующий
    автообновляющий git pull падает с «local changes would be overwritten».
    """
    src = os.path.abspath('rust/bin/a11-bot')
    if not os.path.exists(src):
        return None
    target = os.path.join(tempfile.gettempdir(), 'a11-bot-check')
    try:
        shutil.copyfile(src, target)
        os.chmod(target, 0o755)
    except OSError as e:
        print(f'RUST-CHECK: копия не удалась: {e}', flush=True)
        return None
    return target


def rust_check():
    """Проверка Rust-бинарника на хосте: результат в консоль и в .rust-check.txt.

    Файл нужен, чтобы результат можно было прочитать через панель: консоль видит
    только человек. Ничего не решает и не останавливает запуск — любая ошибка
    становится строкой. Убрать вместе с переключением бота на Rust.
    """
    from datetime import datetime, timedelta, timezone
    stamp = datetime.now(timezone(timedelta(hours=3))).strftime('%Y-%m-%d %H:%M:%S')
    lines = [f'RUST-CHECK {stamp} +03']
    # режим, испорченный прошлой версией проверки, возвращаем к тому, что в git
    try:
        subprocess.run(['git', 'checkout', '--', 'rust/bin/a11-bot'],
                       capture_output=True, timeout=20)
    except Exception:
        pass
    path = rust_binary()
    if path is None:
        lines.append('бинарника нет, пропуск')
    else:
        for args, title in ((['--selftest', '1'], 'RUST-SELFTEST'),
                            (['--check-net'], 'RUST-NET')):
            try:
                r = subprocess.run([path] + args, capture_output=True, text=True, timeout=30)
                out = (r.stdout or r.stderr).strip().replace('\n', ' | ')
                lines.append(f'{title}: rc={r.returncode} {out[:300]}')
            except Exception as e:  # noexec, таймаут, что угодно — бот всё равно стартует
                lines.append(f'{title}: ошибка {e.__class__.__name__}: {e}')
    text = '\n'.join(lines) + '\n'
    try:
        with open('.rust-check.txt', 'w', encoding='utf-8') as f:
            f.write(text)
    except OSError as e:
        print(f'RUST-CHECK: файл не записался: {e}', flush=True)
    print(text, end='', flush=True)


rust_check()

os.execv(sys.executable, [sys.executable, '-X', 'utf8', 'bot.py'])
