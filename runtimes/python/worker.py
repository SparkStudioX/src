"""Trusted project-script worker. Process separation is not a security sandbox."""
import contextlib
import concurrent.futures
import datetime
import importlib
import importlib.abc
import importlib.util
import json
import math
import os
import sys
import traceback
import types
import threading

# Preserve a private protocol descriptor. Native extensions and subprocesses that
# write directly to fd 1 must not corrupt the gateway's JSON channel.
protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.set_inheritable(protocol.fileno(), False)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
protocol_lock = threading.Lock()


def send(message):
    protocol.write(json.dumps(message, default=str, allow_nan=False) + "\n")
    protocol.flush()


def call(method, arguments):
    with protocol_lock:
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

    def getValue(self):
        return self.value

    def getQuality(self):
        return self.quality

    def getTimestamp(self):
        return self.timestamp


class TagPath(str):
    def getItemName(self):
        return self.rsplit("/", 1)[-1].split("]", 1)[-1]

    def getParentPath(self):
        return TagPath(self.rsplit("/", 1)[0] if "/" in self else self.split("]", 1)[0] + "]")


class Event(dict):
    def __init__(self, value):
        super().__init__((key, self._wrap(item)) for key, item in value.items())

    @classmethod
    def _wrap(cls, value):
        if isinstance(value, dict):
            return cls(value)
        if isinstance(value, list):
            return [cls._wrap(item) for item in value]
        return value

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as error:
            raise AttributeError(name) from error

    def getCurrentValue(self):
        return self.get("newValue")

    getValue = getCurrentValue

    def getPreviousValue(self):
        return self.get("previousValue")

    def getTagPath(self):
        return self.get("tagPath")


message_workers = concurrent.futures.ThreadPoolExecutor(max_workers=4)
message_slots = threading.BoundedSemaphore(32)


def message_call(project=None, messageHandler=None, payload=None, timeoutSec=10, one_way=False):
    if not isinstance(payload if payload is not None else {}, dict):
        raise TypeError("Message payload must be a dictionary.")
    response = call("message.send" if one_way else "message.request", {
        "project": project, "messageHandler": messageHandler, "payload": payload or {}, "timeoutSec": timeoutSec,
    })
    if one_way:
        return response
    if not response.get("success"):
        raise RuntimeError(response.get("stderr") or "Message handler failed.")
    return response.get("result")


def send_message(project=None, messageHandler=None, payload=None):
    return message_call(project, messageHandler, payload, one_way=True)


def send_request(project=None, messageHandler=None, payload=None, timeoutSec=10):
    return message_call(project, messageHandler, payload, timeoutSec)


def send_request_async(project=None, messageHandler=None, payload=None, timeoutSec=10):
    if not message_slots.acquire(blocking=False):
        raise RuntimeError("At most 32 asynchronous requests may be pending per script.")
    try:
        future = message_workers.submit(send_request, project, messageHandler, payload, timeoutSec)
        future.add_done_callback(lambda _: message_slots.release())
        return future
    except BaseException:
        message_slots.release()
        raise


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


def ui_scalar(value):
    if type(value) not in (str, bool, int, float):
        raise TypeError("UI values must be text, Boolean or finite numbers.")
    if type(value) is int and abs(value) > 9007199254740991:
        raise ValueError("UI integer values must be exactly representable JavaScript safe integers.")
    if type(value) is float and (not math.isfinite(value) or value.is_integer() and abs(value) > 9007199254740991):
        raise ValueError("UI numbers must be finite with exact safe integers.")
    return value


class UiProperties:
    """Only the gateway validates property names, values and same-form access."""
    def __init__(self, component_id):
        object.__setattr__(self, "_component_id", component_id)

    def __getattr__(self, name):
        return call("ui.getProperty", {"componentId": self._component_id, "property": name})

    def __setattr__(self, name, value):
        call("ui.setProperty", {"componentId": self._component_id, "property": name, "value": ui_scalar(value)})

    __getitem__ = __getattr__
    __setitem__ = __setattr__


class UiState:
    def __init__(self, scope):
        # No valid declared state identifier can collide with this storage key.
        object.__setattr__(self, "\0scope", scope)

    def __getattr__(self, key):
        return call("ui.getState", {"scope": object.__getattribute__(self, "\0scope"), "key": key})

    def __setattr__(self, key, value):
        call("ui.setState", {"scope": object.__getattribute__(self, "\0scope"), "key": key, "value": ui_scalar(value)})

    __getitem__ = __getattr__
    __setitem__ = __setattr__


class UiParent:
    def __init__(self, context):
        self._context = context

    @property
    def id(self):
        return self._context["parentId"]

    @property
    def name(self):
        return self._context["parentName"]

    @property
    def custom(self):
        return UiState(self._context["customScope"])

    def getChild(self, component_id):
        if not isinstance(component_id, str) or component_id not in self._context["componentIds"]:
            raise KeyError(f"UI component ID {component_id!r} is unavailable in this form.")
        return UiComponent(component_id, self)


class UiComponent:
    __slots__ = ("_component_id", "_parent")
    _writable_properties = frozenset((
        "text", "value", "enabled", "visible", "color", "backgroundColor", "foregroundColor",
        "borderColor", "borderWidth", "fontSize",
    ))

    def __init__(self, component_id, parent):
        object.__setattr__(self, "_component_id", component_id)
        object.__setattr__(self, "_parent", parent)

    def __getattr__(self, name):
        if name in self._writable_properties:
            return self.props[name]
        raise AttributeError(f"Unknown UI component attribute {name!r}. Use a supported UI property or self.props for property access.")

    def __setattr__(self, name, value):
        if name in self._writable_properties:
            self.props[name] = value
            return
        if name in ("id", "name", "props", "parent", "getSibling") or name.startswith("_"):
            raise AttributeError(f"UI component attribute {name!r} is read-only. Only supported UI properties can be assigned.")
        raise AttributeError(f"Unknown UI component property {name!r}. Assign a supported property such as text, enabled or visible.")

    @property
    def id(self):
        return self._component_id

    @property
    def name(self):
        return self._component_id

    @property
    def props(self):
        return UiProperties(self._component_id)

    @property
    def parent(self):
        return self._parent

    def getSibling(self, component_id):
        return self._parent.getChild(component_id)


class UnavailableUi:
    def __getattr__(self, name):
        raise RuntimeError("UI helpers are available only in a runtime Python UI action or saved UI Preview context.")

    def __setattr__(self, name, value):
        raise RuntimeError("UI helpers are available only in a runtime Python UI action or saved UI Preview context.")


request = json.loads(sys.stdin.readline())
parameters = request.get("parameters") or {}
inputs = request.get("inputs") or {}
system = types.ModuleType("system")
system.tag = types.SimpleNamespace(
    readBlocking=lambda paths, timeout=45000: [QualifiedValue(v) for v in call("tag.read", {"paths": paths, "parameters": parameters})],
    writeBlocking=lambda paths, values, timeout=45000: [Quality(q) for q in call("tag.write", {"paths": paths, "values": values})],
)
system.db = types.SimpleNamespace(runNamedQuery=run_named_query)
system.util = types.SimpleNamespace(getLogger=Logger, jsonEncode=json.dumps, jsonDecode=json.loads,
                                   sendMessage=send_message, sendRequest=send_request, sendRequestAsync=send_request_async)
system.date = types.SimpleNamespace(now=lambda: datetime.datetime.now(datetime.timezone.utc))
system.dataset = types.SimpleNamespace(toPyDataSet=lambda dataset: dataset)
system.ui = types.SimpleNamespace(
    sendMessage=lambda messageType, payload=None, sessionId=None: call("ui.sendMessage", {"messageType": messageType, "payload": {} if payload is None else payload, "sessionId": sessionId}),
    getSessionInfo=lambda: call("ui.getSessionInfo", {}),
    getState=lambda scope, key: call("ui.getState", {"scope": scope, "key": key}),
    setState=lambda scope, key, value: call("ui.setState", {"scope": scope, "key": key, "value": ui_scalar(value)}),
    getProperty=lambda componentId, property: call("ui.getProperty", {"componentId": componentId, "property": property}),
    setProperty=lambda componentId, property, value: call("ui.setProperty", {"componentId": componentId, "property": property, "value": ui_scalar(value)}),
)
ui_context = request.get("uiContext")
self_proxy = UiParent(ui_context).getChild(ui_context["selfId"]) if ui_context else UnavailableUi()
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
        module.__dict__.update(system=system, parameters=parameters, inputs=inputs, self=self_proxy)
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
event = Event(request.get("eventContext") or {})
for field in ("previousValue", "newValue"):
    if isinstance(event.get(field), dict):
        event[field] = QualifiedValue(event[field])
if "tagPath" in event:
    event["tagPath"] = TagPath(event["tagPath"])
namespace = {"__name__": "__sparkstudio_script__", "system": system, "project": project, "parameters": parameters, "inputs": inputs, "result": None, "event": event, "self": self_proxy}
for field in ("actor", "resources", "payload", "executionCount", "initialChange", "previousValue", "newValue", "tagPath", "changes", "missedEvents"):
    if field in event:
        namespace[field] = event[field]
success = True
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    try:
        exec(compile(request["code"], "<project-script>", "exec"), namespace)
    except BaseException:
        success = False
        traceback.print_exc()
    finally:
        # Keep request/reply frames ahead of the terminal result; the host deadline
        # still bounds outstanding asynchronous work and kills the process on timeout.
        message_workers.shutdown(wait=True, cancel_futures=True)
try:
    send({"type": "result", "success": success, "stdout": stdout.text, "stderr": stderr.text, "result": namespace.get("result") if success else None})
except (TypeError, ValueError):
    send({"type": "result", "success": False, "stdout": stdout.text, "stderr": "Script result is not JSON serializable.", "result": None})
