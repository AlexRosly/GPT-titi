"""Container transport only. Docker is the security boundary, not Python exec."""
import base64, json, os, pathlib, signal, stat, subprocess, sys, threading
ROOT = pathlib.Path('/work')
MAX_WIRE = 38 * 1024 * 1024

def read_regular(path, maximum):
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally: os.close(directory)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_size > maximum:
            raise ValueError('invalid output')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            data = f.read(maximum + 1)
        if len(data) > maximum: raise ValueError('output too large')
        return data
    finally: os.close(fd)

def check_limits(memory_mib):
    """Refuse execution when the host kernel silently ignores Docker limits."""
    status = dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
    if os.getuid() != 10001 or int(status.get('Seccomp','0')) != 2 or int(status.get('NoNewPrivs','0')) != 1 or int(status.get('CapEff','1').strip(),16) != 0:
        raise ValueError('process isolation unavailable')
    if any(p.name != 'lo' for p in pathlib.Path('/sys/class/net').iterdir()):
        raise ValueError('network isolation unavailable')
    cg = pathlib.Path('/sys/fs/cgroup')
    if (cg/'cgroup.controllers').exists():
        memory = int((cg/'memory.max').read_text().strip())
        pids = int((cg/'pids.max').read_text().strip())
        quota, period = (cg/'cpu.max').read_text().split()
        cpu = int(quota) / int(period)
        swap_path = cg/'memory.swap.max'
        swap = int(swap_path.read_text().strip()) if swap_path.exists() else None
    else:
        def value(controller, name):
            for path in (cg/controller/name, cg/'cpu,cpuacct'/name, cg/'cpuacct,cpu'/name, cg/name):
                if path.exists(): return int(path.read_text().strip())
            raise ValueError('missing cgroup limit')
        memory = value('memory','memory.limit_in_bytes')
        pids = value('pids','pids.max')
        cpu = value('cpu','cpu.cfs_quota_us') / value('cpu','cpu.cfs_period_us')
        try: swap = value('memory','memory.memsw.limit_in_bytes') - memory
        except ValueError: swap = None
    if not (0 < memory <= memory_mib*1024*1024 and 0 < pids <= 64 and 0 < cpu <= 1):
        raise ValueError('unenforced cgroup limits')
    if swap != 0:
        # Kernels without swap accounting are acceptable only with no host swap.
        meminfo = pathlib.Path('/proc/meminfo').read_text()
        swap_total = next(int(line.split()[1]) for line in meminfo.splitlines() if line.startswith('SwapTotal:'))
        if swap_total: raise ValueError('swap not bounded')
    if os.statvfs(ROOT).f_blocks * os.statvfs(ROOT).f_frsize > 256*1024*1024:
        raise ValueError('temporary filesystem not bounded')

def main():
    # Independent watchdog also survives a disconnected/orphaned Docker client.
    watchdog = threading.Timer(70, lambda: os._exit(124)); watchdog.daemon = True; watchdog.start()
    data = sys.stdin.buffer.read(MAX_WIRE + 1)
    if len(data) > MAX_WIRE: raise ValueError('request too large')
    req = json.loads(data)
    try: check_limits(req['memoryMiB'])
    except Exception:
        print(json.dumps({'ok':False,'text':'COMPUTE_KERNEL_LIMITS_UNAVAILABLE: configure Docker memory, CPU, PID and swap limits.','truncated':False,'exports':[]}),flush=True)
        return
    for sub in ('input','previous','output'): (ROOT/sub).mkdir(exist_ok=True)
    for f in req['files']:
        rel = pathlib.PurePosixPath(f['path'])
        if rel.is_absolute() or '..' in rel.parts or rel.parts[0] not in ('input','previous'): raise ValueError('path')
        path = ROOT/rel; path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(base64.b64decode(f['data'],validate=True))
    script = ROOT/'script.py'; script.write_text(req['code'],encoding='utf-8')
    proc = subprocess.Popen([sys.executable,'-I',str(script)],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ))
    captured = bytearray(); overflow = [False]
    def drain():
        while True:
            chunk=proc.stdout.read(4096)
            if not chunk: break
            room=16384-len(captured); captured.extend(chunk[:max(0,room)])
            if len(chunk)>room: overflow[0]=True
    reader=threading.Thread(target=drain,daemon=True);reader.start()
    timeout=False
    try: proc.wait(timeout=min(60,max(1,req['timeoutMs']/1000)))
    except subprocess.TimeoutExpired: timeout=True
    finally:
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
    reader.join(timeout=1)
    exports=[];total=0
    if not timeout and proc.returncode==0:
        # The sandbox response is untrusted; the host validates and sanitizes again.
        for e in req['exports']:
            p=e['path']
            if not p or '/' in p or '\\' in p or '..' in p: raise ValueError('path')
            raw=read_regular(ROOT/'output'/p,25*1024*1024)
            total+=len(raw)
            if total>25*1024*1024: raise ValueError('output limit')
            exports.append({'filename':e['filename'],'data':base64.b64encode(raw).decode('ascii')})
    print(json.dumps({'ok':not timeout and proc.returncode==0,'timeout':timeout,'text':captured.decode('utf-8',errors='replace'),'truncated':overflow[0],'exports':exports}),flush=True)
    watchdog.cancel()

if __name__ == '__main__':
    try: main()
    except Exception:
        print(json.dumps({'ok':False,'text':'Execution or export validation failed.','truncated':False,'exports':[]}),flush=True)
