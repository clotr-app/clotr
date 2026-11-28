package app.clotr.jetbrains.engine

// ---------- What the engine hands back ----------

/** `group`: the engine's own sort of the kind, "credentials" or "personal" (and "custom" or "links"). */
data class Finding(
    val id: String, val type: String, val name: String, val severity: String, val preview: String, val fp: String,
    val group: String = "",
)

/** `stoppedAt`: a check that ran out of time read everything before this point in full; -1 when not known. */
class Scan(val findings: List<Finding>, val ranges: List<DetectedRange>, val truncated: Boolean, val stoppedAt: Int = -1)

class Pass(val found: List<Found>, val truncated: Boolean)

/** A value the engine found, kept only in memory while Hide it runs. Its text never goes in toString(). */
class Found(val type: String, val severity: String, internal val value: String) {
    override fun equals(other: Any?) = other is Found && other.type == type && other.value == value
    override fun hashCode() = 31 * type.hashCode() + value.hashCode()
    override fun toString() = "Found($type)"
}

class DetectedRange(
    val start: Int, val end: Int, val type: String, val severity: String, val fp: String, internal val value: String,
)
