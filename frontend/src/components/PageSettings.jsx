import React, { useState, useEffect } from 'react';
import { Plus, Settings, Calendar, Edit2, Trash2, X, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import * as api from '../services/api';

// 预设的 emoji 头像列表（12个）
const PRESET_AVATARS = ['😀', '😎', '🤗', '🥳', '😇', '🤓', '🤔', '👻', '🐱', '🐶', '🦊', '🐼'];

const PageSettings = ({ users, globalDate, setGlobalDate }) => {
    const [newName, setNewName] = useState('');
    const [selectedUser, setSelectedUser] = useState(null); // For Modal
    const [editName, setEditName] = useState(''); // Name inside modal
    const [editAvatar, setEditAvatar] = useState(''); // Avatar inside modal
    const [isEditingAvatar, setIsEditingAvatar] = useState(false); // 是否正在编辑头像（自定义输入）

    const [isDeleting, setIsDeleting] = useState(false); // State to track deletion status

    // 折叠状态（从 localStorage 读取，默认展开）
    const [isCollapsed, setIsCollapsed] = useState(() => {
        const saved = localStorage.getItem('pageSettingsCollapsed');
        return saved === null ? false : saved === 'true';
    });

    // 跟踪是否已经首次渲染，用于控制动画
    const hasRendered = React.useRef(false);
    useEffect(() => {
        hasRendered.current = true;
    }, []);

    // 保存折叠状态到 localStorage
    useEffect(() => {
        localStorage.setItem('pageSettingsCollapsed', isCollapsed);
    }, [isCollapsed]);

    // 获取随机 emoji
    const getRandomAvatar = () => {
        return PRESET_AVATARS[Math.floor(Math.random() * PRESET_AVATARS.length)];
    };

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!newName.trim()) return;
        try {
            // 随机分配一个 emoji 头像
            await api.createUser(newName, getRandomAvatar());
            setNewName('');
        } catch (err) {
            alert(err.response?.data?.detail || 'Error adding user');
        }
    };

    const handleDelete = async (id) => {
        // if (!confirm('确定要删除该成员吗？')) return;
        setIsDeleting(true);
        try {
            await api.deleteUser(id);
            closeModal();
        } catch (err) {
            setIsDeleting(false);
            alert(err.response?.data?.detail || 'Error deleting user');
        }
    };

    const closeModal = () => {
        setSelectedUser(null);
        setIsEditingAvatar(false);
        // Note: We don't reset isDeleting here to allow the exit animation to read it.
        // It will be reset on next openModal.
    };

    const handleUpdate = async () => {
        if (!editName.trim()) return;

        // 检查是否有更改
        const nameChanged = editName !== selectedUser.name;
        const avatarChanged = editAvatar !== (selectedUser.avatar || '😀');

        // 如果没有更改，只关闭弹窗
        if (!nameChanged && !avatarChanged) {
            closeModal();
            return;
        }

        try {
            await api.updateUser(selectedUser.id, editName, editAvatar);
            closeModal();
        } catch (err) {
            alert(err.response?.data?.detail || 'Update Failed');
        }
    };

    const openModal = (user) => {
        setIsDeleting(false); // Reset deletion state on open
        setSelectedUser(user);
        setEditName(user.name);
        setEditAvatar(user.avatar || '😀');
        setIsEditingAvatar(false);
    };

    // 获取用户头像显示
    const getAvatarDisplay = (user) => {
        if (user.avatar && user.avatar !== 'default') {
            return user.avatar;
        }
        return user.name[0].toUpperCase();
    };

    // 判断是否为 emoji 头像
    const isEmoji = (avatar) => {
        return avatar && avatar !== 'default' && !/^[A-Za-z]$/.test(avatar);
    };

    return (
        <>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                {/* 可点击的标题栏 */}
                <div
                    className="flex items-center justify-between p-6 cursor-pointer hover:bg-gray-50 transition-colors"
                    onClick={() => setIsCollapsed(!isCollapsed)}
                >
                    <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                        <Settings size={20} className="text-primary" />
                        页面配置
                        <motion.div
                            initial={false}
                            animate={{ rotate: isCollapsed ? -90 : 0 }}
                            transition={{ duration: 0.2 }}
                        >
                            <ChevronDown size={18} className="text-gray-400" />
                        </motion.div>
                    </h2>
                </div>

                {/* 可折叠的内容区域 */}
                <AnimatePresence initial={false}>
                    {!isCollapsed && (
                        <motion.div
                            key="content"
                            initial={hasRendered.current ? { height: 0, opacity: 0 } : false}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                            className="overflow-hidden"
                        >
                            <div className="px-6 pb-6 flex flex-col gap-6">
                                {/* Global Date Selection */}
                                <div>
                                    <label className="block text-sm font-medium text-gray-500 mb-2">
                                        日期选择
                                    </label>
                                    <input
                                        type="date"
                                        value={globalDate}
                                        onChange={e => setGlobalDate(e.target.value)}
                                        className="w-full max-w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-gray-800 font-medium text-center focus:ring-2 focus:ring-primary/20 outline-none appearance-none"
                                        style={{ boxSizing: 'border-box' }}
                                    />
                                </div>

                                {/* User Management Section */}
                                <div>
                                    <label className="block text-sm font-medium text-gray-500 mb-3">人员配置</label>
                                    <div className="flex flex-wrap gap-3 mb-4">
                                        {users.map(u => (
                                            <button
                                                key={u.id}
                                                onClick={() => openModal(u)}
                                                className="group relative flex flex-col items-center focus:outline-none"
                                            >
                                                <motion.div
                                                    layoutId={`avatar-${u.id}`}
                                                    className={`w-12 h-12 rounded-full flex items-center justify-center text-lg border-2 border-transparent group-hover:border-primary/30 transition-colors ${isEmoji(u.avatar) ? 'bg-gray-100 text-2xl' : 'bg-primary-light text-primary-dark font-bold'}`}
                                                >
                                                    {getAvatarDisplay(u)}
                                                </motion.div>
                                                <span className="text-xs mt-1 text-gray-600 truncate max-w-[60px]">{u.name}</span>
                                            </button>
                                        ))}
                                    </div>

                                    {/* 简洁的添加表单，不显示emoji选择 */}
                                    <form onSubmit={handleAdd} className="flex gap-2">
                                        <input
                                            type="text"
                                            value={newName}
                                            onChange={e => setNewName(e.target.value)}
                                            placeholder="新成员姓名"
                                            className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                                            maxLength={10}
                                        />
                                        <button type="submit" className="bg-primary text-white p-2 rounded-lg hover:bg-primary-dark transition-colors shadow-sm">
                                            <Plus size={20} />
                                        </button>
                                    </form>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* User Detail Modal */}
            <AnimatePresence>
                {selectedUser && (
                    <motion.div
                        className="fixed top-0 left-0 right-0 bottom-0 bg-black/50 flex items-center justify-center z-50"
                        style={{ margin: 0 }}
                        onClick={closeModal}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                    >
                        <motion.div
                            layoutId={isDeleting ? undefined : `avatar-${selectedUser.id}`}
                            className="bg-white rounded-xl p-6 w-80 shadow-xl overflow-y-auto"
                            onClick={(e) => e.stopPropagation()}
                            transition={{ type: "spring", stiffness: 300, damping: 30 }}
                            exit={isDeleting ? {
                                opacity: 0,
                                scale: 1.5,
                                filter: "blur(10px)",
                                transition: { duration: 0.3, ease: "easeIn" }
                            } : { opacity: 0, scale: 0.9 }}
                        >
                            <div className="flex justify-between items-center mb-6">
                                <h3 className="text-lg font-bold text-gray-800">编辑成员</h3>
                                <button onClick={closeModal} className="text-gray-400 hover:text-gray-600">
                                    <X size={20} />
                                </button>
                            </div>

                            {/* 当前头像显示 - 点击可以输入自定义 */}
                            <div className="flex justify-center mb-4">
                                {isEditingAvatar ? (
                                    <input
                                        type="text"
                                        value={editAvatar}
                                        onChange={e => setEditAvatar(e.target.value)}
                                        onBlur={() => setIsEditingAvatar(false)}
                                        autoFocus
                                        placeholder="输入 emoji"
                                        className="w-20 h-20 rounded-full bg-gray-100 text-4xl text-center border-2 border-primary focus:outline-none"
                                        maxLength={2}
                                    />
                                ) : (
                                    <button
                                        onClick={() => setIsEditingAvatar(true)}
                                        className={`w-20 h-20 rounded-full flex items-center justify-center text-4xl cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all ${isEmoji(editAvatar) ? 'bg-gray-100' : 'bg-primary-light text-primary-dark font-bold'}`}
                                        title="点击输入自定义 emoji"
                                    >
                                        {isEmoji(editAvatar) ? editAvatar : editName[0]?.toUpperCase()}
                                    </button>
                                )}
                            </div>

                            {/* 头像选择区 - 12个预设 */}
                            <div className="mb-4">
                                <label className="block text-xs text-gray-500 mb-2">选择头像</label>
                                <div className="flex flex-wrap gap-2 justify-center">
                                    {PRESET_AVATARS.map(emoji => (
                                        <button
                                            key={emoji}
                                            type="button"
                                            onClick={() => { setEditAvatar(emoji); setIsEditingAvatar(false); }}
                                            className={`w-9 h-9 rounded-full flex items-center justify-center text-xl transition-all ${editAvatar === emoji ? 'bg-primary/20 ring-2 ring-primary scale-110' : 'bg-gray-100 hover:bg-gray-200'}`}
                                        >
                                            {emoji}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs text-gray-500 mb-1">姓名</label>
                                    <input
                                        type="text"
                                        value={editName}
                                        onChange={e => setEditName(e.target.value)}
                                        className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 text-center font-medium"
                                    />
                                </div>

                                <button
                                    onClick={handleUpdate}
                                    className="w-full bg-primary text-white py-2 rounded-lg font-bold hover:bg-primary-dark transition-colors flex items-center justify-center gap-2"
                                >
                                    <Edit2 size={16} /> 保存修改
                                </button>

                                <button
                                    onClick={() => handleDelete(selectedUser.id)}
                                    className="w-full bg-red-50 text-red-500 py-2 rounded-lg font-bold hover:bg-red-100 transition-colors flex items-center justify-center gap-2"
                                >
                                    <Trash2 size={16} /> 删除成员
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
};

export default PageSettings;
