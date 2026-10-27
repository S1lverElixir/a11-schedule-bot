import os, subprocess, sys

os.environ.setdefault("MALLOC_ARENA_MAX", "1")

if not os.path.exists('.git'):
    REPO = 'https://{u}:{t}@github.com/S1lverElixir/a11-schedule-bot.git'.format(
        u=os.environ.get('USERNAME', ''), t=os.environ.get('ACCESS_TOKEN', ''))
    subprocess.run(['git', 'init'], check=True)
    subprocess.run(['git', 'remote', 'add', 'origin', REPO], check=True)
    subprocess.run(['git', 'fetch', '--depth', '1', 'origin', 'main'], check=True)
    subprocess.run(['git', 'reset', '--hard', 'FETCH_HEAD'], check=True)

# wheels в репозитории: pip в лимите 128 МБ падает по памяти при сетевой установке
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '--no-index', '--find-links', 'wheels', '-r', 'requirements.txt'], check=True)
print('WHEELS-OK, starting bot', flush=True)

os.execv(sys.executable, [sys.executable, '-X', 'utf8', 'bot.py'])
