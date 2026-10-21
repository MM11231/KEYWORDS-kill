(function (exports) {
    "use strict";

    const { before } = vendetta.patcher;
    const { findByName, findByStoreName, findByProps } = vendetta.metro;
    const { React, ReactNative, FluxDispatcher } = vendetta.metro.common;
    const { useProxy } = vendetta.storage;
    const { FormSection, FormInput, FormRow, FormSwitch, FormText } = vendetta.ui.components.Forms;
    const { ScrollView, Alert, View, Text, TouchableOpacity } = ReactNative;
    const storage = vendetta.plugin.storage;
    const h = React.createElement;

    // ---------- 初始化 / 兼容旧版（逗号分隔） ----------
    if (!Array.isArray(storage.list)) {
        const old = typeof storage.keywords === "string" ? storage.keywords : "";
        storage.list = old
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((w) => ({ word: w, enabled: true }));
    }
    if (typeof storage.enabled !== "boolean") storage.enabled = true;
    if (typeof storage.maskSelf !== "boolean") storage.maskSelf = false;

    function toast(text) {
        try {
            ReactNative.ToastAndroid.show(String(text), ReactNative.ToastAndroid.SHORT);
        } catch (e) {}
    }

    // ---------- 当前用户 ID（用来跳过自己的消息） ----------
    let myId = null;
    function getMyId() {
        if (myId) return myId;
        try {
            const store = findByStoreName("UserStore");
            const u = store && store.getCurrentUser && store.getCurrentUser();
            if (u && u.id) return (myId = u.id);
        } catch (e) {}
        try {
            const mod = findByProps("getCurrentUser");
            const u = mod && mod.getCurrentUser && mod.getCurrentUser();
            if (u && u.id) return (myId = u.id);
        } catch (e) {}
        return null;
    }

    // ---------- 遮罩逻辑 ----------
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cache = { sig: null, re: null };

    function getRegex() {
        const words = storage.list
            .filter((i) => i.enabled && i.word)
            .map((i) => i.word)
            .sort((a, b) => b.length - a.length);
        const sig = words.join("\u0000");
        if (cache.sig !== sig) {
            cache.sig = sig;
            cache.re = words.length ? new RegExp(words.map(esc).join("|"), "gi") : null;
        }
        return cache.re;
    }

    function mask(text) {
        if (!storage.enabled) return text;
        const re = getRegex();
        if (!re) return text;
        re.lastIndex = 0;
        return text.replace(re, (m, offset) => {
            if (text.slice(Math.max(0, offset - 2), offset) === "||") return m;
            if (text.slice(offset + m.length, offset + m.length + 2) === "||") return m;
            return "||" + m + "||";
        });
    }

    // ---------- 让已显示的消息立刻生效 ----------
    // 原理：对当前聊天里已加载的消息，用原文各发一次“消息更新”，
    // 触发重新渲染，渲染时会按最新的关键词重新遮罩。
    function refreshMessages() {
        try {
            const SelectedChannelStore = findByStoreName("SelectedChannelStore");
            const MessageStore = findByStoreName("MessageStore");
            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) return false;

            const collection = MessageStore.getMessages(channelId);
            const list =
                (collection && collection._array) ||
                (collection && typeof collection.toArray === "function" ? collection.toArray() : []);
            if (!list || !list.length) return false;

            for (const msg of list) {
                const content =
                    msg.__kwmOrig !== undefined && msg.content === msg.__kwmOut ? msg.__kwmOrig : msg.content;
                if (typeof content !== "string" || !content) continue;
                FluxDispatcher.dispatch({
                    type: "MESSAGE_UPDATE",
                    message: {
                        id: msg.id,
                        channel_id: msg.channel_id || channelId,
                        guild_id: msg.guild_id,
                        content: content,
                    },
                });
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    let refreshTimer = null;
    function scheduleRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refreshMessages();
        }, 300);
    }

    let unpatch;

    exports.onLoad = () => {
        const RowManager = findByName("RowManager");
        unpatch = before("generate", RowManager.prototype, ([row]) => {
            try {
                if (!row || row.rowType !== 1 || !row.message) return;
                const msg = row.message;
                const cur = msg.content;
                if (typeof cur !== "string" || !cur) return;

                // 记住原文，这样关闭某个关键词后能恢复显示
                let orig = cur;
                if (msg.__kwmOut !== undefined && cur === msg.__kwmOut) orig = msg.__kwmOrig;

                // 自己发的消息：默认不遮罩，并把之前改过的还原
                const mine = msg.author && getMyId() && msg.author.id === getMyId();
                const next = mine && !storage.maskSelf ? orig : mask(orig);

                msg.__kwmOrig = orig;
                msg.__kwmOut = next;
                if (next !== cur) msg.content = next;
            } catch (e) {
                // 出错就跳过这条消息
            }
        });
    };

    exports.onUnload = () => {
        if (unpatch) unpatch();
        if (refreshTimer) clearTimeout(refreshTimer);
    };

    // ---------- 按钮组件 ----------
    function Btn(props) {
        const colors = { primary: "#5865F2", secondary: "#4E5058", danger: "#ED4245" };
        const small = !!props.small;
        return h(
            TouchableOpacity,
            {
                onPress: props.onPress,
                activeOpacity: 0.7,
                style: Object.assign(
                    {
                        backgroundColor: colors[props.kind || "primary"],
                        borderRadius: 8,
                        paddingVertical: small ? 6 : 12,
                        paddingHorizontal: small ? 12 : 16,
                        alignItems: "center",
                        justifyContent: "center",
                    },
                    props.style || {}
                ),
            },
            h(
                Text,
                { style: { color: "#FFFFFF", fontWeight: "600", fontSize: small ? 13 : 15 } },
                props.text
            )
        );
    }

    // ---------- 设置页 ----------
    exports.settings = () => {
        useProxy(storage);
        const [draft, setDraft] = React.useState("");
        const [query, setQuery] = React.useState("");

        const canAdd = draft.trim().length > 0;

        const add = () => {
            const w = draft.trim();
            if (!w) return toast("请先输入关键词");
            if (storage.list.some((i) => i.word.toLowerCase() === w.toLowerCase())) {
                return toast("这个关键词已经存在");
            }
            storage.list = [{ word: w, enabled: true }, ...storage.list];
            setDraft("");
            toast("已添加：" + w);
            scheduleRefresh();
        };

        const q = query.trim().toLowerCase();
        const shown = storage.list.filter((i) => !q || i.word.toLowerCase().includes(q));

        const setShown = (v) => {
            const set = new Set(shown.map((i) => i.word));
            storage.list = storage.list.map((i) => (set.has(i.word) ? { word: i.word, enabled: v } : i));
            toast(v ? "已启用 " + shown.length + " 个" : "已停用 " + shown.length + " 个");
            scheduleRefresh();
        };

        const toggle = (word, v) => {
            storage.list = storage.list.map((i) => (i.word === word ? { word: word, enabled: v } : i));
            scheduleRefresh();
        };

        const remove = (word) => {
            Alert.alert("删除关键词", "确定删除「" + word + "」吗？", [
                { text: "取消", style: "cancel" },
                {
                    text: "删除",
                    style: "destructive",
                    onPress: () => {
                        storage.list = storage.list.filter((i) => i.word !== word);
                        scheduleRefresh();
                    },
                },
            ]);
        };

        const applyNow = () => {
            toast(refreshMessages() ? "已应用到当前聊天" : "没能刷新，请切换一次频道");
        };

        return h(
            ScrollView,
            { style: { flex: 1 } },

            h(
                FormSection,
                { title: "总开关" },
                h(FormRow, {
                    label: "启用关键词遮罩",
                    trailing: h(FormSwitch, {
                        value: storage.enabled,
                        onValueChange: (v) => {
                            storage.enabled = v;
                            scheduleRefresh();
                        },
                    }),
                }),
                h(FormRow, {
                    label: "也遮罩自己发的消息",
                    trailing: h(FormSwitch, {
                        value: storage.maskSelf,
                        onValueChange: (v) => {
                            storage.maskSelf = v;
                            scheduleRefresh();
                        },
                    }),
                }),
                h(
                    View,
                    { style: { paddingHorizontal: 16, paddingVertical: 8 } },
                    h(Btn, { text: "立即应用到当前聊天", kind: "secondary", onPress: applyNow })
                ),
                h(
                    FormText,
                    { style: { paddingHorizontal: 16, paddingBottom: 8 } },
                    "修改关键词后会自动应用，没反应时可以点上面的按钮"
                )
            ),

            h(
                FormSection,
                { title: "添加关键词" },
                h(FormInput, {
                    title: "新关键词",
                    placeholder: "输入一个关键词",
                    value: draft,
                    onChange: setDraft,
                }),
                h(
                    View,
                    { style: { paddingHorizontal: 16, paddingVertical: 8 } },
                    h(Btn, {
                        text: canAdd ? "＋ 确认添加" : "先输入关键词",
                        kind: canAdd ? "primary" : "secondary",
                        onPress: add,
                    })
                )
            ),

            h(
                FormSection,
                { title: "关键词列表（" + shown.length + "/" + storage.list.length + "）" },
                h(FormInput, {
                    title: "搜索",
                    placeholder: "输入文字筛选关键词",
                    value: query,
                    onChange: setQuery,
                }),
                h(
                    View,
                    { style: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 8 } },
                    h(Btn, {
                        text: "全部启用",
                        kind: "primary",
                        style: { flex: 1, marginRight: 8 },
                        onPress: () => setShown(true),
                    }),
                    h(Btn, {
                        text: "全部停用",
                        kind: "secondary",
                        style: { flex: 1 },
                        onPress: () => setShown(false),
                    })
                ),
                h(FormText, { style: { paddingHorizontal: 16, paddingBottom: 8 } }, "上面两个按钮只对当前筛选出的关键词生效"),
                shown.length
                    ? shown.map((i) =>
                          h(FormRow, {
                              key: i.word,
                              label: i.word,
                              subLabel: i.enabled ? "已启用" : "已停用",
                              trailing: h(
                                  View,
                                  { style: { flexDirection: "row", alignItems: "center" } },
                                  h(Btn, {
                                      text: "删除",
                                      kind: "danger",
                                      small: true,
                                      style: { marginRight: 12 },
                                      onPress: () => remove(i.word),
                                  }),
                                  h(FormSwitch, {
                                      value: i.enabled,
                                      onValueChange: (v) => toggle(i.word, v),
                                  })
                              ),
                          })
                      )
                    : h(FormText, { style: { paddingHorizontal: 16 } }, q ? "没有匹配的关键词" : "还没有添加关键词")
            )
        );
    };

    return exports;
})({});
