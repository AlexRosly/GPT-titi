"""Host-independent fixtures for the fail-closed container preflight."""
import importlib.util
import pathlib
import types
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('compute_runner', pathlib.Path(__file__).resolve().parents[2] / 'computation-worker/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class KernelLimits(unittest.TestCase):
    def check(self, changes=None, v1=False):
        files = {
            '/proc/self/status': 'Seccomp: 2\nNoNewPrivs: 1\nCapEff: 0000000000000000\n',
            '/proc/meminfo': 'SwapTotal: 0 kB\n',
        }
        root = '/sys/fs/cgroup/'
        if v1:
            files.update({root+'memory/memory.limit_in_bytes': str(512*1024**2), root+'pids/pids.max': '64', root+'cpu,cpuacct/cpu.cfs_quota_us': '100000', root+'cpu,cpuacct/cpu.cfs_period_us': '100000'})
        else:
            files.update({root+'cgroup.controllers': 'memory cpu pids', root+'memory.max': str(512*1024**2), root+'pids.max': '64', root+'cpu.max': '100000 100000', root+'memory.swap.max': '0'})
        files.update(changes or {})
        def read(path, *args, **kwargs):
            value = files.get(str(path))
            if value is None: raise FileNotFoundError()
            return value
        with patch.object(pathlib.Path,'read_text',read), patch.object(pathlib.Path,'exists',lambda path: files.get(str(path)) is not None), patch.object(pathlib.Path,'iterdir',lambda path: iter([pathlib.Path('lo')])), patch.object(runner.os,'getuid',return_value=10001), patch.object(runner.os,'statvfs',return_value=types.SimpleNamespace(f_blocks=65536,f_frsize=4096)):
            runner.check_limits(512)
    def test_cgroup_v2(self): self.check()
    def test_cgroup_v1_without_host_swap(self): self.check(v1=True)
    def test_unbounded_memory_rejected(self):
        with self.assertRaises(ValueError): self.check({'/sys/fs/cgroup/memory.max': 'max'})
    def test_excess_memory_rejected(self):
        with self.assertRaisesRegex(ValueError,'CGROUP_LIMIT_NOT_ENFORCED'): self.check({'/sys/fs/cgroup/memory.max': str(1024*1024**2)})
    def test_missing_pid_limit_rejected(self):
        with self.assertRaises(FileNotFoundError): self.check({'/sys/fs/cgroup/pids.max': None})
    def test_missing_swap_accounting_with_host_swap_rejected(self):
        with self.assertRaisesRegex(ValueError,'SWAP_NOT_BOUNDED'): self.check({'/proc/meminfo':'SwapTotal: 1024 kB\n'},v1=True)
    def test_seccomp_required(self):
        with self.assertRaisesRegex(ValueError,'SECCOMP_UNAVAILABLE'): self.check({'/proc/self/status':'Seccomp: 0\nNoNewPrivs: 1\nCapEff: 0\n'})
if __name__ == '__main__': unittest.main()
