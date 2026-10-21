(function (exports) {
    "use strict";

    // Vendetta / Bunny 风格插件
    // 不写入 MessageStore
    // 不 dispatch MESSAGE_UPDATE
    // 不直接修改原始消息内容

    const { before } = vendetta.patcher;
    const {
        findByName,
        findByStoreName,
        findByProps
    } = vendetta.metro;

    const {
        React,
        ReactNative
    } = vendetta.metro.common;

    const { useProxy } = vendetta.storage;

    const {
        FormSection,
        FormRow,
        FormSwitch,
        FormText
    } = vendetta.ui.components.Forms;

    const {
        ScrollView,
        Alert,
        View,
        Text,
        TextInput,
        TouchableOpacity
    } = ReactNative;

    const storage = vendetta.plugin.storage;
    const h = React.createElement;

    // ========================================
    // 初始化与旧版数据兼容
    // ========================================

    function cleanList(value) {
        const incoming = Array.isArray(value)
            ? value
            : (
                typeof storage.keywords === "string"
                    ? storage.keywords.split(/[,，]/)
                    : []
            );

        const seen = new Set();
        const result = [];

        for (const item of incoming) {
            const word =
                typeof item === "string"
                    ? item
                    : item && item.word;

            if (typeof word !== "string") continue;

            const w = word.trim();

            if (!w || w.includes("||") || w.length > 100) {
                continue;
            }

            const id = w.toLowerCase();

            if (seen.has(id)) continue;

            seen.add(id);

            result.push({
                word: w,
                enabled:
                    typeof item === "object"
                        ? item.enabled !== false
                        : true
            });
        }

        return result;
    }

    storage.list = cleanList(storage.list);

    if (typeof storage.enabled !== "boolean") {
        storage.enabled = true;
    }

    if (typeof storage.maskSelf !== "boolean") {
        storage.maskSelf = false;
    }

    // ========================================
    // 通知
    // ========================================

    function toast(message) {
        try {
            if (
                ReactNative.Platform.OS === "android" &&
                ReactNative.ToastAndroid
            ) {
                ReactNative.ToastAndroid.show(
                    String(message),
                    ReactNative.ToastAndroid.SHORT
                );
            }
        } catch (_) {}
    }

    // ========================================
    // 获取当前用户
    // ========================================

    let userStore;

    function getMyId() {
        try {
            if (!userStore) {
                userStore =
                    findByStoreName("UserStore") ||
                    findByProps("getCurrentUser");
            }

            const user =
                userStore &&
                userStore.getCurrentUser &&
                userStore.getCurrentUser();

            return user && user.id != null
                ? String(user.id)
                : null;

        } catch (_) {
            return null;
        }
    }

    // ========================================
    // 关键词正则
    // ========================================

    function escapeRegex(s) {
        return s.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );
    }

    let signature = "";
    let regex = null;

    function currentRegex() {
        if (!storage.enabled) return null;

        const words = (
            Array.isArray(storage.list)
                ? storage.list
                : []
        )
            .filter(
                i =>
                    i &&
                    i.enabled &&
                    typeof i.word === "string" &&
                    i.word
            )
            .map(i => i.word)
            .sort((a, b) => b.length - a.length);

        const key = JSON.stringify(words);

        if (key !== signature) {
            signature = key;

            regex = words.length
                ? new RegExp(
                    words.map(escapeRegex).join("|"),
                    "gi"
                )
                : null;
        }

        return regex;
    }

    // ========================================
    // 核心遮罩逻辑
    // ========================================

    function mask(text) {
        if (typeof text !== "string" || !text) {
            return text;
        }

        const re = currentRegex();

        if (!re) return text;

        // 保留已经存在的剧透块
        const spoiler = /\|\|[\s\S]*?\|\|/g;

        let cursor = 0;
        let result = "";
        let m;

        while ((m = spoiler.exec(text)) !== null) {
            result += text
                .slice(cursor, m.index)
                .replace(
                    re,
                    x => "||" + x + "||"
                );

            result += m[0];

            cursor = spoiler.lastIndex;
        }

        result += text
            .slice(cursor)
            .replace(
                re,
                x => "||" + x + "||"
            );

        return result;
    }

    // ========================================
    // 扫描已经加载的历史消息
    // ========================================

    function scanLoadedMessages() {
        const selected =
            findByStoreName("SelectedChannelStore");

        const messages =
            findByStoreName("MessageStore");

        const channelId =
            selected &&
            selected.getChannelId &&
            selected.getChannelId();

        if (
            !channelId ||
            !messages ||
            typeof messages.getMessages !== "function"
        ) {
            return {
                error:
                    "无法读取当前频道，请先进入聊天再打开设置"
            };
        }

        const collection =
            messages.getMessages(channelId);

        const items = Array.isArray(collection)
            ? collection
            : (
                collection &&
                Array.isArray(collection._array)
                    ? collection._array
                    : (
                        collection &&
                        typeof collection.toArray === "function"
                            ? collection.toArray()
                            : []
                    )
            );

        // 只扫描最多500条已加载消息
        const safeItems = Array.isArray(items)
            ? items.slice(-500)
            : [];

        const counts = Object.create(null);

        const words = (
            Array.isArray(storage.list)
                ? storage.list
                : []
        )
            .filter(
                i =>
                    i &&
                    typeof i.word === "string"
            )
            .map(i => ({
                key: i.word.toLowerCase(),
                word: i.word.toLowerCase()
            }));

        for (const { key } of words) {
            counts[key] = 0;
        }

        let scanned = 0;

        for (const message of safeItems) {
            if (
                !message ||
                typeof message.content !== "string"
            ) {
                continue;
            }

            scanned++;

            const content =
                message.content.toLowerCase();

            for (const { key, word } of words) {
                if (content.includes(word)) {
                    counts[key]++;
                }
            }
        }

        return {
            channelId,
            counts,
            scanned,
            matched:
                Object.values(counts)
                    .filter(n => n > 0)
                    .length
        };
    }

    // ========================================
    // 消息渲染 Hook
    // ========================================

    let unpatch = null;

    exports.onLoad = () => {
        if (unpatch) return;

        try {
            const RowManager =
                findByName("RowManager");

            if (
                !RowManager ||
                !RowManager.prototype ||
                typeof RowManager.prototype.generate !== "function"
            ) {
                console.warn(
                    "[KeywordMask] RowManager.generate 不可用"
                );
                return;
            }

            unpatch = before(
                "generate",
                RowManager.prototype,
                (args) => {
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
                            typeof msg.content !== "string" ||
                            !msg.content
                        ) {
                            return;
                        }

                        const me = getMyId();

                        // 是否跳过自己的消息
                        if (
                            !storage.maskSelf &&
                            me &&
                            msg.author &&
                            String(msg.author.id) === me
                        ) {
                            return;
                        }

                        const out = mask(msg.content);

                        if (out === msg.content) {
                            return;
                        }

                        // 克隆消息对象，不改动原始消息
                        const viewMsg = Object.assign(
                            Object.create(
                                Object.getPrototypeOf(msg)
                            ),
                            msg,
                            { content: out }
                        );

                        // 克隆聊天行
                        const viewRow = Object.assign(
                            Object.create(
                                Object.getPrototypeOf(row)
                            ),
                            row,
                            { message: viewMsg }
                        );

                        args[0] = viewRow;

                    } catch (e) {
                        console.warn(
                            "[KeywordMask] 本条消息未遮罩",
                            e
                        );
                    }
                }
            );

        } catch (e) {
            console.warn(
                "[KeywordMask] 加载失败",
                e
            );
        }
    };

    // ========================================
    // 卸载插件
    // ========================================

    exports.onUnload = () => {
        if (typeof unpatch === "function") {
            try {
                unpatch();
            } catch (_) {}
        }

        unpatch = null;
    };

    // ========================================
    // 按钮组件
    // ========================================

    function Btn({
        text,
        kind = "primary",
        onPress,
        small,
        style
    }) {
        const bg = {
            primary: "#5865F2",
            secondary: "#50545E",
            danger: "#D83C3E"
        }[kind];

        return h(
            TouchableOpacity,
            {
                onPress,
                activeOpacity: 0.8,
                style: Object.assign(
                    {
                        backgroundColor: bg,
                        borderRadius: 9,
                        paddingVertical: small ? 8 : 12,
                        paddingHorizontal: small ? 10 : 14,
                        alignItems: "center",
                        justifyContent: "center"
                    },
                    style || {}
                )
            },
            h(
                Text,
                {
                    style: {
                        color: "#FFFFFF",
                        fontSize: small ? 13 : 15,
                        fontWeight: "600"
                    }
                },
                text
            )
        );
    }

    // ========================================
    // 输入框组件
    // ========================================

    function Field({
        label,
        value,
        onChangeText,
        placeholder
    }) {
        return h(
            View,
            {
                style: {
                    paddingHorizontal: 16,
                    paddingTop: 10,
                    paddingBottom: 8
                }
            },
            h(
                Text,
                {
                    style: {
                        fontSize: 13,
                        color: "#B5BAC1",
                        marginBottom: 8
                    }
                },
                label
            ),
            h(TextInput, {
                value,
                onChangeText,
                placeholder,
                placeholderTextColor: "#A4A6AE",
                autoCapitalize: "none",
                autoCorrect: false,
                style: {
                    borderRadius: 9,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    color: "#FFFFFF",
                    backgroundColor: "#303238",
                    fontSize: 15,
                    borderWidth: 1,
                    borderColor: "#4D5059"
                }
            })
        );
    }

    // ========================================
    // 插件设置页面
    // ========================================

    exports.settings = () => {
        useProxy(storage);

        const [draft, setDraft] =
            React.useState("");

        const [query, setQuery] =
            React.useState("");

        const [scan, setScan] =
            React.useState(null);

        const list =
            Array.isArray(storage.list)
                ? storage.list
                : [];

        const q =
            query.trim().toLowerCase();

        const shown = list.filter(
            i => i.word.toLowerCase().includes(q)
        );

        const matched =
            scan && !scan.error
                ? list.filter(
                    i =>
                        (
                            scan.counts[
                                i.word.toLowerCase()
                            ] || 0
                        ) > 0
                )
                : [];

        // 修改单个关键词状态
        function updateWord(word, enabled) {
            storage.list = (
                storage.list || []
            ).map(
                i =>
                    i.word === word
                        ? {
                            word: i.word,
                            enabled
                        }
                        : i
            );
        }

        // 批量修改关键词状态
        function updateBatch(items, enabled) {
            const names = new Set(
                items.map(
                    i => i.word.toLowerCase()
                )
            );

            storage.list = (
                storage.list || []
            ).map(
                i =>
                    names.has(
                        i.word.toLowerCase()
                    )
                        ? {
                            word: i.word,
                            enabled
                        }
                        : i
            );

            toast(
                "已修改 " +
                names.size +
                " 个关键词"
            );
        }

        // 添加关键词
        function add() {
            const word = draft.trim();

            if (!word) {
                return toast("先输入关键词");
            }

            if (
                word.length > 100 ||
                word.includes("||")
            ) {
                return toast(
                    "关键词长度不能超过100，且不能包含 ||"
                );
            }

            if (
                list.some(
                    i =>
                        i.word.toLowerCase() ===
                        word.toLowerCase()
                )
            ) {
                return toast(
                    "关键词已存在，可在列表里启用"
                );
            }

            storage.list = [
                {
                    word,
                    enabled: true
                },
                ...list
            ];

            setDraft("");
            setScan(null);

            toast("添加成功");
        }

        // 删除关键词
        function remove(word) {
            Alert.alert(
                "删除关键词",
                "删除「" + word + "」？",
                [
                    {
                        text: "取消",
                        style: "cancel"
                    },
                    {
                        text: "删除",
                        style: "destructive",
                        onPress: () => {
                            storage.list = (
                                storage.list || []
                            ).filter(
                                i => i.word !== word
                            );

                            setScan(null);
                        }
                    }
                ]
            );
        }

        // 扫描当前频道
        function runScan() {
            try {
                const result =
                    scanLoadedMessages();

                setScan(result);

                if (result.error) {
                    toast(result.error);
                } else {
                    toast(
                        "扫描完成：" +
                        result.matched +
                        " 个关键词出现在已加载消息中"
                    );
                }

            } catch (e) {
                setScan({
                    error:
                        "扫描失败：当前版本可能不支持读取消息缓存"
                });
            }
        }

        // ====================================
        // 设置页面布局
        // ====================================

        return h(
            ScrollView,
            {
                style: { flex: 1 },
                keyboardShouldPersistTaps: "handled"
            },

            // 总开关
            h(
                FormSection,
                {
                    title: "关键词遮罩"
                },

                h(FormRow, {
                    label: "启用遮罩",
                    trailing: h(FormSwitch, {
                        value: storage.enabled,
                        onValueChange: v => {
                            storage.enabled = v;
                        }
                    })
                }),

                h(FormRow, {
                    label: "也遮罩自己发的消息",
                    trailing: h(FormSwitch, {
                        value: storage.maskSelf,
                        onValueChange: v => {
                            storage.maskSelf = v;
                        }
                    })
                }),

                h(
                    FormText,
                    {
                        style: {
                            paddingHorizontal: 16,
                            paddingBottom: 10
                        }
                    },
                    "只改变本地显示，不修改服务器消息。" +
                    "设置更改后切换一次频道，" +
                    "让已加载的旧消息重新渲染。"
                )
            ),

            // 添加关键词
            h(
                FormSection,
                {
                    title: "添加新关键词"
                },

                h(Field, {
                    label: "关键词",
                    value: draft,
                    onChangeText: setDraft,
                    placeholder: "输入要遮盖的词"
                }),

                h(
                    View,
                    {
                        style: {
                            paddingHorizontal: 16,
                            paddingBottom: 12
                        }
                    },
                    h(Btn, {
                        text: "添加并启用",
                        onPress: add
                    })
                )
            ),

            // 历史消息扫描
            h(
                FormSection,
                {
                    title: "在旧聊天中选择关键词"
                },

                h(
                    FormText,
                    {
                        style: {
                            paddingHorizontal: 16,
                            paddingVertical: 8
                        }
                    },
                    "扫描当前频道已加载的消息，" +
                    "查找已保存关键词出现了多少次。" +
                    "只扫描本地缓存，不拉取全部聊天记录。"
                ),

                h(
                    View,
                    {
                        style: {
                            paddingHorizontal: 16,
                            paddingBottom: 8
                        }
                    },
                    h(Btn, {
                        text: "扫描当前频道",
                        kind: "secondary",
                        onPress: runScan
                    })
                ),

                scan
                    ? h(
                        FormText,
                        {
                            style: {
                                paddingHorizontal: 16,
                                paddingBottom: 8
                            }
                        },
                        scan.error ||
                        (
                            "已扫描 " +
                            scan.scanned +
                            " 条消息，命中 " +
                            scan.matched +
                            " 个关键词。"
                        )
                    )
                    : null,

                matched.length
                    ? h(
                        View,
                        {
                            style: {
                                flexDirection: "row",
                                paddingHorizontal: 16,
                                paddingBottom: 12
                            }
                        },

                        h(Btn, {
                            text:
                                "启用命中词（" +
                                matched.length +
                                "）",
                            small: true,
                            style: {
                                flex: 1,
                                marginRight: 8
                            },
                            onPress: () =>
                                updateBatch(
                                    matched,
                                    true
                                )
                        }),

                        h(Btn, {
                            text: "停用命中词",
                            small: true,
                            kind: "secondary",
                            style: {
                                flex: 1
                            },
                            onPress: () =>
                                updateBatch(
                                    matched,
                                    false
                                )
                        })
                    )
                    : null
            ),

            // 已保存关键词
            h(
                FormSection,
                {
                    title:
                        "已保存关键词（" +
                        list.filter(i => i.enabled).length +
                        "/" +
                        list.length +
                        " 已启用）"
                },

                h(Field, {
                    label: "搜索已有关键词",
                    value: query,
                    onChangeText: setQuery,
                    placeholder: "筛选关键词"
                }),

                h(
                    View,
                    {
                        style: {
                            flexDirection: "row",
                            paddingHorizontal: 16,
                            paddingVertical: 8
                        }
                    },

                    h(Btn, {
                        text: "启用筛选结果",
                        small: true,
                        style: {
                            flex: 1,
                            marginRight: 8
                        },
                        onPress: () =>
                            updateBatch(
                                shown,
                                true
                            )
                    }),

                    h(Btn, {
                        text: "停用筛选结果",
                        small: true,
                        kind: "secondary",
                        style: {
                            flex: 1
                        },
                        onPress: () =>
                            updateBatch(
                                shown,
                                false
                            )
                    })
                ),

                shown.length
                    ? shown.map(item => {
                        const count =
                            scan &&
                            !scan.error &&
                            scan.counts[
                                item.word.toLowerCase()
                            ];

                        const suffix =
                            typeof count === "number"
                                ? " · 本频道 " +
                                  count +
                                  " 条"
                                : "";

                        return h(FormRow, {
                            key: item.word,
                            label: item.word,

                            subLabel:
                                (
                                    item.enabled
                                        ? "遮罩开启"
                                        : "遮罩关闭"
                                ) + suffix,

                            trailing: h(
                                View,
                                {
                                    style: {
                                        flexDirection: "row",
                                        alignItems: "center"
                                    }
                                },

                                h(Btn, {
                                    text: "删除",
                                    kind: "danger",
                                    small: true,
                                    style: {
                                        marginRight: 10
                                    },
                                    onPress: () =>
                                        remove(item.word)
                                }),

                                h(FormSwitch, {
                                    value: item.enabled,
                                    onValueChange: v =>
                                        updateWord(
                                            item.word,
                                            v
                                        )
                                })
                            )
                        });
                    })
                    : h(
                        FormText,
                        {
                            style: {
                                paddingHorizontal: 16,
                                paddingVertical: 12
                            }
                        },
                        q
                            ? "没有匹配的关键词"
                            : "还没有保存关键词"
                    )
            )
        );
    };

    return exports;

})({});
