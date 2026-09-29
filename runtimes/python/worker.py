"""Trusted project-script worker. Process separation is not a security sandbox."""
import contextlib
import datetime
import importlib
import importlib.abc
import importlib.util
import json
import sys
import traceback
import types

protocol = sys.stdout


def send(message):
    protocol.write(json.dumps(message, default=str, allow_nan=False) + "\n")
    protocol.flush()


def call(method, arguments):
    send({"type": "call", "method": method, "arguments": arguments})
    response = json.loads(sys.stdin.readline())
    if "error" in response:
        raise RuntimeError(response["error"])
    return response.get("result")


class LimitedOutput:
    def __init__(self):
        self.text = ""

    def write(self, text):
        self.text += str(text)[: max(0, 65536 - len(self.text))]
        return len(text)

    def flush(self):
        pass


class Quality:
    def __init__(self, code):
        self.code = code

    def isGood(self):
        return self.code.startswith("Good")

    def isBad(self):
        return self.code.startswith("Bad")

    def __str__(self):
        return self.code


class QualifiedValue:
    def __init__(self, item):
        self.value = item["value"]
        self.quality = Quality(item["quality"])
        self.timestamp = datetime.datetime.fromisoformat(item["timestamp"].replace("Z", "+00:00"))


class Dataset:
    def __init__(self, payload):
        self.columns = payload["columns"]
        self.rows = payload["rows"]

    def getRowCount(self):
        return len(self.rows)

    def getColumnCount(self):
        return len(self.columns)

    def getColumnNames(self):
        return list(self.columns)

    def getValueAt(self, row, column):
        return self.rows[row][self.columns[column] if isinstance(column, int) else column]

    def __iter__(self):
        return iter(self.rows)


def run_named_query(name, parameters=None):
    value = call("db.query", {"name": name, "parameters": parameters or {}})
    if isinstance(value, dict) and "columns" in value and "rows" in value:
        return Dataset(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    raise TypeError("Named query returned neither a dataset nor an affected-row count.")


class Logger:
    def __init__(self, name):
        self.name = name

    def info(self, message):
        print(f"INFO [{self.name}] {message}")

    def warn(self, message):
        print(f"WARN [{self.name}] {message}")

    def error(self, message):
        print(f"ERROR [{self.name}] {message}")

    debug = info


request = json.loads(sys.stdin.readline())
parameters = request.get("parameters") or {}
inputs = request.get("inputs") or {}
system = types.ModuleType("system")
system.tag = types.SimpleNamespace(
    readBlocking=lambda paths, timeout=45000: [QualifiedValue(v) for v in call("tag.read", {"paths": paths, "parameters": parameters})],
    writeBlocking=lambda paths, values, timeout=45000: [Quality(q) for q in call("tag.write", {"paths": paths, "values": values})],
)
system.db = types.SimpleNamespace(runNamedQuery=run_named_query)
system.util = types.SimpleNamespace(getLogger=Logger, jsonEncode=json.dumps, jsonDecode=json.loads)
system.date = types.SimpleNamespace(now=lambda: datetime.datetime.now(datetime.timezone.utc))
system.dataset = types.SimpleNamespace(toPyDataSet=lambda dataset: dataset)
sys.modules["system"] = system


class ProjectLibraries(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Trusted published modules loaded in memory, once per worker invocation."""

    def __init__(self, sources):
        self.sources = sources

    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith("project.") and fullname[8:] in self.sources:
            return importlib.util.spec_from_loader(fullname, self)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.__dict__.update(system=system, parameters=parameters, inputs=inputs)
        exec(compile(self.sources[module.__name__[8:]], f"<{module.__name__}>", "exec"), module.__dict__)


libraries = request.get("libraries") or {}
project = types.ModuleType("project")
project.__path__ = []


def load_project_library(name):
    if name not in libraries:
        raise AttributeError(f"No published project library named {name!r}.")
    return importlib.import_module(f"project.{name}")


project.__getattr__ = load_project_library
sys.modules["project"] = project
sys.meta_path.insert(0, ProjectLibraries(libraries))
stdout, stderr = LimitedOutput(), LimitedOutput()
namespace = {"__name__": "__sparkstudio_script__", "system": system, "project": project, "parameters": parameters, "inputs": inputs, "result": None}
success = True
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    try:
        exec(compile(request["code"], "<project-script>", "exec"), namespace)
    except BaseException:
        success = False
        traceback.print_exc()
try:
    send({"type": "result", "success": success, "stdout": stdout.text, "stderr": stderr.text, "result": namespace.get("result") if success else None})
except (TypeError, ValueError):
    send({"type": "result", "success": False, "stdout": stdout.text, "stderr": "Script result is not JSON serializable.", "result": None})
