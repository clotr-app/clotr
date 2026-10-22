package app.clotr.jetbrains

import com.intellij.AbstractBundle
import org.jetbrains.annotations.PropertyKey

object ClotrBundle : AbstractBundle("messages.ClotrBundle") {
    fun message(@PropertyKey(resourceBundle = "messages.ClotrBundle") key: String, vararg params: Any): String = getMessage(key, *params)
}
