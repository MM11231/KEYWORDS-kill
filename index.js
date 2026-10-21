(function (exports) {
    "use strict";

    // 不调用 Toast 或 Alert
    const api =
        typeof vendetta !== "undefined"
            ? vendetta
            : null;

    if (
        !api ||
        !api.metro ||
        !api.metro.common ||
        !api.plugin ||
        !api.patcher
    ) {
        exports.onLoad = () => {};
        exports.onUnload = () => {};
        exports.settings = () => null;
        return exports;
    }

    const { React, ReactNative } = api.metro.common;
    const { findByName, findByStoreName } = api.metro;
    const { before } = api.patcher;
    const store = api.plugin.storage;

    const {
        ScrollView,
        View,
        Text,
        TextInput,
        Switch,
        TouchableOpacity
    } = ReactNative;

    const h = React.createElement;

    // ---------- 关键词数据 ----------

    function normalize(items) {
        const old = Array.isArray(items)
            ? items
            : typeof store.keywords === "string"
                ? store.keywords.split(/[,，]/)
                : [];

        const seen = new Set();

        return old.reduce((out, item) => {
            const word =
                typeof item === "string"
                    ? item
                    : item && item.word;

            if (typeof word !== "string") return out;

            const w = word.trim();

            if (
                !w ||
                w.length > 100 ||
                w.includes("||") ||
                seen.has(w.toLowerCase())
            ) {
                return out;
            }

            seen.add(w.toLowerCase());

            out.push({
                word: w,
                enabled:
                    typeof item === "string" ||
                    item.enabled !== false
            });

            return out;
        }, []);
    }

    store.list = normalize(store.list);

    if (typeof store.enabled !== "boolean") {
        store.enabled = true;
    }

    if (typeof store.maskSelf !== "boolean") {
        store.maskSelf = false;
    }

    let unpatch = null;
    let active = false;
    let cachedSignature = null;
    let cachedRegex = null;

    // ---------- 构造关键词正则 ----------

    function getRegex() {
        const words = (store.list || [])
            .filter(x => x && x.enabled && x.word)
            .map(x => x.word)
            .sort((a, b) => b.length - a.length);

        const signature = JSON.stringify(words);

        if (signature !== cachedSignature) {
            cachedSignature = signature;

            cachedRegex = words.length
                ? new RegExp(
                    words
                        .map(w =>
                            w.replace(
                                /[.*+?^${}()|[\]\\]/g,
                                "\\$&"
                            )
                        )
                        .join("|"),
                    "gi"
                )
                : null;
        }

        return cachedRegex;
    }

    // ---------- 消息遮罩 ----------

    function mask(text) {
        if (
            !store.enabled ||
            typeof text !== "string" ||
            !text
        ) {
            return text;
        }

        const regex = getRegex();

        if (!regex) return text;

        // 已有剧透块不重复处理
        const pieces = text.split(
            /(\|\|[\s\S]*?\|\|)/g
        );

        return pieces
            .map(part => {
                if (
                    part.startsWith("||") &&
                    part.endsWith("||")
                ) {
                    return part;
                }

                return part.replace(
                    regex,
                    word => `||${word}||`
                );
            })
            .join("");
    }

    // ---------- 当前用户 ----------

    function myId() {
        try {
            const us = findByStoreName("UserStore");

            const user =
                us &&
                us.getCurrentUser &&
                us.getCurrentUser();

            return user && user.id != null
                ? String(user.id)
                : null;
        } catch (_) {
            return null;
        }
    }

    // ---------- 手动启动遮罩 ----------

    function start() {
        if (active) {
            return "遮罩已经启动";
        }

        try {
            if (
                typeof before !== "function" ||
                typeof findByName !== "function"
            ) {
                return "当前客户端不支持此插件接口";
            }

            const manager = findByName("RowManager");

            if (
                !manager ||
                !manager.prototype ||
                typeof manager.prototype.generate !== "function"
            ) {
                return "找不到 RowManager.generate，当前版本可能不兼容";
            }

            const cancel = before(
                "generate",
                manager.prototype,
                args => {
                    try {
                        const row = args && args[0];

                        if (
                            !row ||
                            row.rowType !== 1 ||
                            !row.message
                        ) {
                            return;
                        }

                        const msg = row.message;

                        if (
                            typeof msg.content !== "string"
                        ) {
                            return;
                        }

                        const id = myId();

                        if (
                            !store.maskSelf &&
                            id &&
                            msg.author &&
                            String(msg.author.id) === id
                        ) {
                            return;
                        }

                        const next = mask(msg.content);

                        if (next === msg.content) {
                            return;
                        }

                        // 克隆消息，不修改原始对象
                        const copyMessage = Object.assign(
                            Object.create(
                                Object.getPrototypeOf(msg)
                            ),
                            msg,
                            { content: next }
                        );

                        // 克隆行对象
                        args[0] = Object.assign(
                            Object.create(
                                Object.getPrototypeOf(row)
                            ),
                            row,
                            { message: copyMessage }
                        );

                    } catch (e) {
                        console.warn(
                            "[KeywordMask] 遮罩失败",
                            e
                        );
                    }
                }
            );

            if (typeof cancel !== "function") {
                return "Hook 返回异常，未确认启动成功";
            }

            unpatch = cancel;
            active = true;

            return "遮罩已启动，切换频道后应用历史消息";

        } catch (e) {
            return "启动失败：" +
                String(e && e.message || e);
        }
    }

    // ---------- 停止遮罩 ----------

    function stop() {
        try {
            if (unpatch) unpatch();
        } catch (_) {}

        unpatch = null;
        active = false;

        return "遮罩已停止，切换频道后恢复原始显示";
    }

    // ---------- 扫描历史消息 ----------

    function scanLoaded() {
        try {
            const selected = findByStoreName(
                "SelectedChannelStore"
            );

            const messages = findByStoreName(
                "MessageStore"
            );

            const cid =
                selected &&
                selected.getChannelId &&
                selected.getChannelId();

            if (
                !cid ||
                !messages ||
                typeof messages.getMessages !== "function"
            ) {
                return {
                    error: "无法读取当前频道，请先打开聊天"
                };
            }

            const coll = messages.getMessages(cid);

            const arr = Array.isArray(coll)
                ? coll
                : coll && Array.isArray(coll._array)
                    ? coll._array
                    : coll &&
                      typeof coll.toArray === "function"
                        ? coll.toArray()
                        : [];

            const counts = {};

            for (const item of store.list || []) {
                counts[item.word.toLowerCase()] = 0;
            }

            let scanned = 0;

            for (const m of arr.slice(-500)) {
                if (
                    !m ||
                    typeof m.content !== "string"
                ) {
                    continue;
                }

                scanned++;

                const content = m.content.toLowerCase();

                for (const item of store.list || []) {
                    const key = item.word.toLowerCase();

                    if (content.includes(key)) {
                        counts[key]++;
                    }
                }
            }

            return {
                scanned,
                counts
            };

        } catch (e) {
            return {
                error: "扫描失败，当前客户端可能不支持消息缓存接口"
            };
        }
    }

    // ---------- 插件生命周期 ----------

    // 安装时不自动挂载 Hook
    exports.onLoad = () => {};

    exports.onUnload = stop;

    // ---------- 设置界面样式 ----------

    const styles = {
        title: {
            color: "#FFFFFF",
            fontSize: 17,
            fontWeight: "700",
            marginBottom: 10
        },

        text: {
            color: "#E7E7ED",
            fontSize: 14
        },

        hint: {
            color: "#B8BAC6",
            fontSize: 12,
            marginTop: 6
        },

        input: {
            color: "#FFFFFF",
            backgroundColor: "#30323C",
            borderRadius: 9,
            paddingHorizontal: 12,
            paddingVertical: 10,
            marginVertical: 8
        },

        section: {
            padding: 16,
            borderBottomWidth: 1,
            borderBottomColor: "#42444E"
        },

        button: {
            backgroundColor: "#5865F2",
            paddingHorizontal: 13,
            paddingVertical: 10,
            borderRadius: 9,
            alignItems: "center",
            marginVertical: 4
        },

        row: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginVertical: 7
        }
    };

    // ---------- 按钮 ----------

    function Button({ label, onPress, danger }) {
        return h(
            TouchableOpacity,
            {
                onPress,
                activeOpacity: 0.75,
                style: [
                    styles.button,
                    danger
                        ? { backgroundColor: "#B83B43" }
                        : null
                ]
            },

            h(
                Text,
                {
                    style: {
                        color: "#FFFFFF",
                        fontWeight: "600"
                    }
                },
                label
            )
        );
    }

    // ---------- 设置页面 ----------

    exports.settings = function Settings() {
        const [draft, setDraft] = React.useState("");
        const [query, setQuery] = React.useState("");
        const [result, setResult] = React.useState(null);

        const [notice, setNotice] = React.useState(
            "安装时不会启动遮罩，请在此手动启动。"
        );

        const [, refresh] = React.useState(0);

        const update = () => refresh(x => x + 1);

        const list = Array.isArray(store.list)
            ? store.list
            : [];

        const shown = list.filter(x =>
            x.word
                .toLowerCase()
                .includes(query.trim().toLowerCase())
        );

        // 修改关键词
        function setWords(items, enabled) {
            const names = new Set(
                items.map(x => x.word.toLowerCase())
            );

            store.list = list.map(x =>
                names.has(x.word.toLowerCase())
                    ? { ...x, enabled }
                    : x
            );

            setNotice(
                `已${enabled ? "启用" : "停用"} ` +
                `${names.size} 个关键词，切换频道后应用`
            );

            update();
        }

        // 添加关键词
        function addWord() {
            const w = draft.trim();

            if (
                !w ||
                w.length > 100 ||
                w.includes("||")
            ) {
                setNotice(
                    "请输入1至100字且不包含 || 的关键词"
                );
                return;
            }

            if (
                list.some(
                    x =>
                        x.word.toLowerCase() ===
                        w.toLowerCase()
                )
            ) {
                setNotice("关键词已经存在");
                return;
            }

            store.list = [
                {
                    word: w,
                    enabled: true
                },
                ...list
            ];

            setDraft("");
            setResult(null);

            setNotice(
                "关键词已添加，切换频道后应用"
            );

            update();
        }

        // 删除关键词：不弹确认框
        function removeWord(word) {
            store.list = list.filter(
                x => x.word !== word
            );

            setResult(null);

            setNotice(
                `已删除「${word}」，切换频道后应用`
            );

            update();
        }

        // ---------- UI 辅助 ----------

        const section = (...children) =>
            h(
                View,
                { style: styles.section },
                ...children
            );

        const heading = text =>
            h(
                Text,
                { style: styles.title },
                text
            );

        const hint = text =>
            h(
                Text,
                { style: styles.hint },
                text
            );

        const input = (
            value,
            setter,
            placeholder
        ) =>
            h(TextInput, {
                value,
                onChangeText: setter,
                placeholder,
                placeholderTextColor: "#9295A2",
                style: styles.input,
                autoCapitalize: "none",
                autoCorrect: false
            });

        const sw = (
            label,
            value,
            change
        ) =>
            h(
                View,
                { style: styles.row },

                h(
                    Text,
                    {
                        style: [
                            styles.text,
                            { flex: 1 }
                        ]
                    },
                    label
                ),

                h(Switch, {
                    value,
                    onValueChange: change
                })
            );

        // ---------- 主设置页面 ----------

        return h(
            ScrollView,
            {
                style: {
                    flex: 1,
                    backgroundColor: "#23242C"
                },
                keyboardShouldPersistTaps: "handled"
            },

            // 遮罩控制
            section(
                heading("关键词遮罩"),

                hint(notice),

                h(Button, {
                    label: active
                        ? "停止遮罩"
                        : "启动遮罩",

                    onPress: () => {
                        setNotice(
                            active ? stop() : start()
                        );
                        update();
                    }
                }),

                sw(
                    "启用关键词规则",
                    store.enabled,
                    v => {
                        store.enabled = v;
                        update();
                    }
                ),

                sw(
                    "也遮罩自己发送的消息",
                    store.maskSelf,
                    v => {
                        store.maskSelf = v;
                        update();
                    }
                ),

                hint(
                    "仅改变本地显示。" +
                    "切换频道后，重新加载的历史消息也会应用遮罩。"
                )
            ),

            // 添加关键词
            section(
                heading("添加关键词"),

                input(
                    draft,
                    setDraft,
                    "输入关键词"
                ),

                h(Button, {
                    label: "添加",
                    onPress: addWord
                })
            ),

            // 历史扫描
            section(
                heading("历史聊天扫描"),

                hint(
                    "扫描当前频道已加载的最多500条消息。" +
                    "只查找已经保存的关键词，不自动提取新词。"
                ),

                h(Button, {
                    label: "扫描当前频道",

                    onPress: () => {
                        const r = scanLoaded();

                        setResult(r);

                        setNotice(
                            r.error ||
                            `已扫描 ${r.scanned} 条消息`
                        );
                    }
                }),

                result && !result.error
                    ? h(Button, {
                        label: "启用历史消息命中的关键词",

                        onPress: () =>
                            setWords(
                                list.filter(
                                    x =>
                                        (
                                            result.counts[
                                                x.word.toLowerCase()
                                            ] || 0
                                        ) > 0
                                ),
                                true
                            )
                    })
                    : null
            ),

            // 关键词管理
            section(
                heading(
                    `关键词列表（${
                        list.filter(x => x.enabled).length
                    }/${list.length} 已启用）`
                ),

                input(
                    query,
                    setQuery,
                    "搜索已有关键词"
                ),

                h(Button, {
                    label: "启用筛选结果",
                    onPress: () =>
                        setWords(shown, true)
                }),

                h(Button, {
                    label: "停用筛选结果",
                    onPress: () =>
                        setWords(shown, false)
                }),

                ...shown.map(x =>
                    h(
                        View,
                        {
                            key: x.word,
                            style: {
                                paddingVertical: 9,
                                borderBottomWidth: 1,
                                borderBottomColor: "#3B3D46"
                            }
                        },

                        sw(
                            x.word,
                            x.enabled,
                            value =>
                                setWords([x], value)
                        ),

                        hint(
                            result && !result.error
                                ? `已加载消息中命中 ${
                                    result.counts[
                                        x.word.toLowerCase()
                                    ] || 0
                                } 条`
                                : ""
                        ),

                        h(Button, {
                            label: "删除此词",
                            danger: true,
                            onPress: () =>
                                removeWord(x.word)
                        })
                    )
                )
            )
        );
    };

    return exports;

})({});
