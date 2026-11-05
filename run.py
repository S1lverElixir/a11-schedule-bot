import os, shutil, subprocess, sys, tempfile

os.environ.setdefault("MALLOC_ARENA_MAX", "1")

if not os.path.exists('.git'):
    REPO = 'https://{u}:{t}@github.com/S1lverElixir/a11-schedule-bot.git'.format(
        u=os.environ.get('USERNAME', ''), t=os.environ.get('ACCESS_TOKEN', ''))
    subprocess.run(['git', 'init'], check=True)
    subprocess.run(['git', 'remote', 'add', 'origin', REPO], check=True)
    subprocess.run(['git', 'fetch', '--depth', '1', 'origin', 'main'], check=True)
    subprocess.run(['git', 'reset', '--hard', 'FETCH_HEAD'], check=True)


def exec_rust():
    """Запуск бота на Rust: копия бинарника из временного каталога.

    Файл в репозитории не трогаем: chmod меняет режим в git, и следующий
    автообновляющий git pull падает с «local changes would be overwritten».
    Самотест перед запуском ловит битый или нерабочий бинарник.
    """
    src = os.path.abspath('rust/bin/a11-bot')
    if not os.path.exists(src):
        print('RUST-START: бинарника нет', flush=True)
        return False
    target = os.path.join(tempfile.gettempdir(), 'a11-bot')
    try:
        shutil.copyfile(src, target)
        os.chmod(target, 0o755)
        r = subprocess.run([target, '--selftest', '1'], capture_output=True,
                           text=True, timeout=30)
    except Exception as e:
        print(f'RUST-START: не получилось ({e.__class__.__name__}: {e})', flush=True)
        return False
    if r.returncode != 0:
        tail = (r.stdout or r.stderr or '').strip().splitlines()[-1:] or ['нет вывода']
        print(f'RUST-START: самотест rc={r.returncode}: {tail[0][:200]}', flush=True)
        return False
    print('RUST-START: запускаю бота на Rust', flush=True)
    os.execv(target, [target])
    return False


if not exec_rust():
    # Запасного пути нет: бот только на Rust. Молча работать не будем — экшен
    # сам не подняться, и в консоли панели остаётся причина.
    sys.exit(1)
