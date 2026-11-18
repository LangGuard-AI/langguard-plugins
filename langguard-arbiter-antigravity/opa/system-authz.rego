package system.authz

import rego.v1

default allow := false

allow if {
	input.method == "GET"
	input.path == ["health"]
	_health_params
}

_health_params if count(input.params) == 0

_health_params if input.params == {"bundles": [""]}

allow if {
	input.method == "GET"
	count(input.params) == 0
	input.path in _reads
}

_reads := {
	["v1", "data", "system", "bundles", "arbiter", "manifest", "revision"],
	["v1", "data", "system", "authz", "attest"],
	["v1", "data", "system", "authz", "instance"],
}

allow if {
	input.method == "POST"
	count(input.params) == 0
	input.path in _queries
}

_queries := {
	["v1", "data", "langguard", "scope_tier", "tier"],
	["v1", "data", "langguard", "violations", "result"],
	["v1", "data", "langguard", "violations", "approval_status"],
	["v1", "data", "langguard", "violations", "effective_mode"],
	["v1", "data", "langguard", "violations", "remote_only_classes_active"],
	["v1", "data", "langguard", "violations", "server_policy_applies"],
	["v1", "data", "langguard", "violations", "pii_scan_max_chars"],
	["v1", "data", "langguard", "violations", "local_keys"],
}

allow if {
	input.method == "POST"
	count(input.params) == 0
	count(input.path) == 6
	array.slice(input.path, 0, 5) == ["v1", "data", "langguard", "violations", "policy_outcome"]
	regex.match(`^p_[0-9a-f]{24}$`, input.path[5])
}

_runtime(path, fallback) := object.get(opa.runtime(), array.concat(["config"], path), fallback)

instance := _runtime(["labels", "arbiter_instance"], "")

attest := {
	"authz": opa.runtime().authorization_enabled,
	"authz_digest": _runtime(["labels", "arbiter_authz"], ""),
	"fingerprint": _runtime(["labels", "arbiter_key"], ""),
	"instance": _runtime(["labels", "arbiter_instance"], ""),
	"launch": _runtime(["labels", "arbiter_launch"], ""),
	"keyid": _runtime(["bundles", "arbiter", "signing", "keyid"], ""),
	"scope": _runtime(["bundles", "arbiter", "signing", "scope"], ""),
}
