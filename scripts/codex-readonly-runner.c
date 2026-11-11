#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#if defined(__aarch64__)
#define CODEX_AUDIT_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define CODEX_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__arm__)
#define CODEX_AUDIT_ARCH AUDIT_ARCH_ARM
#elif defined(__i386__)
#define CODEX_AUDIT_ARCH AUDIT_ARCH_I386
#else
#error "Unsupported architecture for Codex IDE read-only runner"
#endif

#define CODEX_DENY_ERRNO(error_number) \
  (SECCOMP_RET_ERRNO | ((error_number) & SECCOMP_RET_DATA))
#define CODEX_DENY_SYSCALL(syscall_name, error_number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##syscall_name, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, CODEX_DENY_ERRNO(error_number))
#define CODEX_NOTIFY_SYSCALL(syscall_name) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##syscall_name, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF)

static int install_filter(int disposable_workspace) {
  const uint32_t write_open_flags = O_ACCMODE | O_CREAT | O_TRUNC | O_APPEND;
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CODEX_AUDIT_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),

#ifdef __NR_open
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_open, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, write_open_flags, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#endif
#ifdef __NR_openat
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, write_open_flags, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#endif
#ifdef __NR_socket
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, CODEX_DENY_ERRNO(EPERM)),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
#endif

#ifdef __NR_openat2
    CODEX_DENY_SYSCALL(openat2, EROFS),
#endif
#ifdef __NR_creat
    CODEX_DENY_SYSCALL(creat, EROFS),
#endif
#ifdef __NR_truncate
    CODEX_DENY_SYSCALL(truncate, EROFS),
#endif
#ifdef __NR_ftruncate
    CODEX_DENY_SYSCALL(ftruncate, EROFS),
#endif
#ifdef __NR_fallocate
    CODEX_DENY_SYSCALL(fallocate, EROFS),
#endif
#ifdef __NR_mkdir
    CODEX_NOTIFY_SYSCALL(mkdir),
#endif
#ifdef __NR_mkdirat
    CODEX_NOTIFY_SYSCALL(mkdirat),
#endif
#ifdef __NR_unlink
    CODEX_NOTIFY_SYSCALL(unlink),
#endif
#ifdef __NR_unlinkat
    CODEX_NOTIFY_SYSCALL(unlinkat),
#endif
#ifdef __NR_rmdir
    CODEX_NOTIFY_SYSCALL(rmdir),
#endif
#ifdef __NR_rename
    CODEX_NOTIFY_SYSCALL(rename),
#endif
#ifdef __NR_renameat
    CODEX_NOTIFY_SYSCALL(renameat),
#endif
#ifdef __NR_renameat2
    CODEX_NOTIFY_SYSCALL(renameat2),
#endif
#ifdef __NR_link
    CODEX_NOTIFY_SYSCALL(link),
#endif
#ifdef __NR_linkat
    CODEX_NOTIFY_SYSCALL(linkat),
#endif
#ifdef __NR_symlink
    CODEX_NOTIFY_SYSCALL(symlink),
#endif
#ifdef __NR_symlinkat
    CODEX_NOTIFY_SYSCALL(symlinkat),
#endif
#ifdef __NR_mknod
    CODEX_DENY_SYSCALL(mknod, EROFS),
#endif
#ifdef __NR_mknodat
    CODEX_DENY_SYSCALL(mknodat, EROFS),
#endif
#ifdef __NR_chmod
    CODEX_DENY_SYSCALL(chmod, EROFS),
#endif
#ifdef __NR_fchmod
    CODEX_DENY_SYSCALL(fchmod, EROFS),
#endif
#ifdef __NR_fchmodat
    CODEX_DENY_SYSCALL(fchmodat, EROFS),
#endif
#ifdef __NR_fchmodat2
    CODEX_DENY_SYSCALL(fchmodat2, EROFS),
#endif
#ifdef __NR_chown
    CODEX_DENY_SYSCALL(chown, EROFS),
#endif
#ifdef __NR_fchown
    CODEX_DENY_SYSCALL(fchown, EROFS),
#endif
#ifdef __NR_lchown
    CODEX_DENY_SYSCALL(lchown, EROFS),
#endif
#ifdef __NR_fchownat
    CODEX_DENY_SYSCALL(fchownat, EROFS),
#endif
#ifdef __NR_setxattr
    CODEX_DENY_SYSCALL(setxattr, EROFS),
#endif
#ifdef __NR_lsetxattr
    CODEX_DENY_SYSCALL(lsetxattr, EROFS),
#endif
#ifdef __NR_fsetxattr
    CODEX_DENY_SYSCALL(fsetxattr, EROFS),
#endif
#ifdef __NR_removexattr
    CODEX_DENY_SYSCALL(removexattr, EROFS),
#endif
#ifdef __NR_lremovexattr
    CODEX_DENY_SYSCALL(lremovexattr, EROFS),
#endif
#ifdef __NR_fremovexattr
    CODEX_DENY_SYSCALL(fremovexattr, EROFS),
#endif
#ifdef __NR_utime
    CODEX_DENY_SYSCALL(utime, EROFS),
#endif
#ifdef __NR_utimes
    CODEX_DENY_SYSCALL(utimes, EROFS),
#endif
#ifdef __NR_futimesat
    CODEX_DENY_SYSCALL(futimesat, EROFS),
#endif
#ifdef __NR_utimensat
    CODEX_DENY_SYSCALL(utimensat, EROFS),
#endif
#ifdef __NR_mount
    CODEX_DENY_SYSCALL(mount, EPERM),
#endif
#ifdef __NR_umount2
    CODEX_DENY_SYSCALL(umount2, EPERM),
#endif
#ifdef __NR_pivot_root
    CODEX_DENY_SYSCALL(pivot_root, EPERM),
#endif
#ifdef __NR_chroot
    CODEX_DENY_SYSCALL(chroot, EPERM),
#endif
#ifdef __NR_swapon
    CODEX_DENY_SYSCALL(swapon, EPERM),
#endif
#ifdef __NR_swapoff
    CODEX_DENY_SYSCALL(swapoff, EPERM),
#endif
#ifdef __NR_bpf
    CODEX_DENY_SYSCALL(bpf, EPERM),
#endif
#ifdef __NR_io_uring_setup
    CODEX_DENY_SYSCALL(io_uring_setup, EPERM),
#endif
#ifdef __NR_ptrace
    CODEX_DENY_SYSCALL(ptrace, EPERM),
#endif
#ifdef __NR_process_vm_writev
    CODEX_DENY_SYSCALL(process_vm_writev, EPERM),
#endif
#ifdef __NR_init_module
    CODEX_DENY_SYSCALL(init_module, EPERM),
#endif
#ifdef __NR_finit_module
    CODEX_DENY_SYSCALL(finit_module, EPERM),
#endif
#ifdef __NR_delete_module
    CODEX_DENY_SYSCALL(delete_module, EPERM),
#endif

    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter
  };

  if (disposable_workspace) {
    size_t instruction_count = sizeof(filter) / sizeof(filter[0]);
    for (size_t index = 0; index < instruction_count; index += 1) {
      if (filter[index].code == (BPF_RET | BPF_K) &&
          (filter[index].k == SECCOMP_RET_USER_NOTIF ||
           filter[index].k == CODEX_DENY_ERRNO(EROFS))) {
        filter[index].k = SECCOMP_RET_ALLOW;
      }
    }
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  if (disposable_workspace) {
    return (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
  }
  return (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                      SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int send_fd(int socket_fd, int descriptor) {
  char marker = 'F';
  struct iovec io = { .iov_base = &marker, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof(control));
  struct msghdr message;
  memset(&message, 0, sizeof(message));
  message.msg_iov = &io;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &descriptor, sizeof(int));
  return sendmsg(socket_fd, &message, 0) == 1 ? 0 : -1;
}

static int receive_fd(int socket_fd) {
  char marker = 0;
  struct iovec io = { .iov_base = &marker, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int))];
  memset(control, 0, sizeof(control));
  struct msghdr message;
  memset(&message, 0, sizeof(message));
  message.msg_iov = &io;
  message.msg_iovlen = 1;
  message.msg_control = control;
  message.msg_controllen = sizeof(control);
  if (recvmsg(socket_fd, &message, 0) != 1) return -1;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (!header || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) return -1;
  int descriptor = -1;
  memcpy(&descriptor, CMSG_DATA(header), sizeof(int));
  return descriptor;
}

static int read_remote_string(pid_t pid, uint64_t address, char *output, size_t output_size) {
  if (!address || output_size < 2) return -1;
  struct iovec local = { .iov_base = output, .iov_len = output_size - 1 };
  struct iovec remote = { .iov_base = (void *)(uintptr_t)address, .iov_len = output_size - 1 };
  ssize_t count = process_vm_readv(pid, &local, 1, &remote, 1, 0);
  if (count <= 0) return -1;
  output[count] = '\0';
  if (!memchr(output, '\0', (size_t)count)) output[count] = '\0';
  return 0;
}

static int read_process_link(pid_t pid, int dirfd, char *output, size_t output_size) {
  char link_path[96];
  if (dirfd == AT_FDCWD) {
    snprintf(link_path, sizeof(link_path), "/proc/%ld/cwd", (long)pid);
  } else {
    snprintf(link_path, sizeof(link_path), "/proc/%ld/fd/%d", (long)pid, dirfd);
  }
  ssize_t count = readlink(link_path, output, output_size - 1);
  if (count <= 0) return -1;
  output[count] = '\0';
  return 0;
}

static int path_has_root(const char *candidate, const char *root) {
  size_t root_length = strlen(root);
  return strncmp(candidate, root, root_length) == 0 &&
    (candidate[root_length] == '\0' || candidate[root_length] == '/');
}

static int protected_segment(const char *segment, size_t length) {
  if (length == 4 && strncasecmp(segment, ".git", length) == 0) return 1;
  if (length == 12 && strncasecmp(segment, "node_modules", length) == 0) return 1;
  if (length >= 4 && strncasecmp(segment, ".env", 4) == 0 &&
      (length == 4 || segment[4] == '.')) return 1;
  return 0;
}

static int path_is_protected(const char *candidate, const char *root) {
  size_t root_length = strlen(root);
  const char *relative = candidate + root_length;
  if (*relative == '/') relative += 1;
  if (!*relative) return 0;
  if (strcasecmp(relative, "memory.md") == 0) return 1;
  while (*relative) {
    const char *separator = strchr(relative, '/');
    size_t length = separator ? (size_t)(separator - relative) : strlen(relative);
    if (protected_segment(relative, length)) return 1;
    if (!separator) break;
    relative = separator + 1;
  }
  return 0;
}

static int path_allowed(const char *candidate, const char *root) {
  return path_has_root(candidate, root) && !path_is_protected(candidate, root);
}

static int resolve_candidate(pid_t pid, int dirfd, uint64_t address,
                             int follow_final, char *resolved, size_t resolved_size) {
  char requested[PATH_MAX];
  if (read_remote_string(pid, address, requested, sizeof(requested)) != 0) return -1;
  char combined[PATH_MAX];
  if (requested[0] == '/') {
    if (snprintf(combined, sizeof(combined), "%s", requested) >= (int)sizeof(combined)) return -1;
  } else {
    char base[PATH_MAX];
    if (read_process_link(pid, dirfd, base, sizeof(base)) != 0) return -1;
    if (snprintf(combined, sizeof(combined), "%s/%s", base, requested) >= (int)sizeof(combined)) return -1;
  }

  if (follow_final && realpath(combined, resolved)) return 0;

  struct stat unresolved_stat;
  if (lstat(combined, &unresolved_stat) == 0 && S_ISLNK(unresolved_stat.st_mode)) return -1;

  char parent_input[PATH_MAX];
  if (snprintf(parent_input, sizeof(parent_input), "%s", combined) >= (int)sizeof(parent_input)) return -1;
  char *slash = strrchr(parent_input, '/');
  const char *name = parent_input;
  if (slash) {
    name = slash + 1;
    if (slash == parent_input) slash[1] = '\0';
    else *slash = '\0';
  } else {
    snprintf(parent_input, sizeof(parent_input), ".");
  }
  char parent_real[PATH_MAX];
  if (!realpath(parent_input, parent_real)) return -1;
  if (!*name) return snprintf(resolved, resolved_size, "%s", parent_real) < (int)resolved_size ? 0 : -1;
  return snprintf(resolved, resolved_size, "%s/%s", parent_real, name) < (int)resolved_size ? 0 : -1;
}

static int path_argument_allowed(const struct seccomp_notif *request, int dirfd,
                                 int path_argument, int follow_final, const char *root) {
  char resolved[PATH_MAX];
  if (!root || !*root) return 0;
  if (resolve_candidate((pid_t)request->pid, dirfd,
                        request->data.args[path_argument], follow_final,
                        resolved, sizeof(resolved)) != 0) return 0;
  return path_allowed(resolved, root);
}

static int notification_allowed(const struct seccomp_notif *request, const char *root) {
  int syscall_number = request->data.nr;
#ifdef __NR_open
  if (syscall_number == __NR_open) {
    return path_argument_allowed(request, AT_FDCWD, 0, 1, root);
  }
#endif
#ifdef __NR_openat
  if (syscall_number == __NR_openat) {
    return path_argument_allowed(request, (int)request->data.args[0], 1, 1, root);
  }
#endif
#ifdef __NR_mkdir
  if (syscall_number == __NR_mkdir) return path_argument_allowed(request, AT_FDCWD, 0, 0, root);
#endif
#ifdef __NR_mkdirat
  if (syscall_number == __NR_mkdirat) return path_argument_allowed(request, (int)request->data.args[0], 1, 0, root);
#endif
#ifdef __NR_unlink
  if (syscall_number == __NR_unlink) return path_argument_allowed(request, AT_FDCWD, 0, 0, root);
#endif
#ifdef __NR_unlinkat
  if (syscall_number == __NR_unlinkat) return path_argument_allowed(request, (int)request->data.args[0], 1, 0, root);
#endif
#ifdef __NR_rmdir
  if (syscall_number == __NR_rmdir) return path_argument_allowed(request, AT_FDCWD, 0, 0, root);
#endif
#ifdef __NR_rename
  if (syscall_number == __NR_rename) {
    return path_argument_allowed(request, AT_FDCWD, 0, 0, root) &&
      path_argument_allowed(request, AT_FDCWD, 1, 0, root);
  }
#endif
#ifdef __NR_renameat
  if (syscall_number == __NR_renameat) {
    return path_argument_allowed(request, (int)request->data.args[0], 1, 0, root) &&
      path_argument_allowed(request, (int)request->data.args[2], 3, 0, root);
  }
#endif
#ifdef __NR_renameat2
  if (syscall_number == __NR_renameat2) {
    return path_argument_allowed(request, (int)request->data.args[0], 1, 0, root) &&
      path_argument_allowed(request, (int)request->data.args[2], 3, 0, root);
  }
#endif
#ifdef __NR_link
  if (syscall_number == __NR_link) {
    return path_argument_allowed(request, AT_FDCWD, 0, 1, root) &&
      path_argument_allowed(request, AT_FDCWD, 1, 0, root);
  }
#endif
#ifdef __NR_linkat
  if (syscall_number == __NR_linkat) {
    return path_argument_allowed(request, (int)request->data.args[0], 1, 1, root) &&
      path_argument_allowed(request, (int)request->data.args[2], 3, 0, root);
  }
#endif
#ifdef __NR_symlink
  if (syscall_number == __NR_symlink) return 0;
#endif
#ifdef __NR_symlinkat
  if (syscall_number == __NR_symlinkat) return 0;
#endif
  return 0;
}

static int resolved_argument(const struct seccomp_notif *request, int dirfd,
                             int path_argument, int follow_final,
                             const char *root, char *resolved) {
  if (resolve_candidate((pid_t)request->pid, dirfd,
                        request->data.args[path_argument], follow_final,
                        resolved, PATH_MAX) != 0) return 0;
  return path_allowed(resolved, root);
}

static void response_from_result(struct seccomp_notif_resp *response, int result) {
  if (result < 0) response->error = -errno;
  else response->val = result;
}

static int emulate_notification(int listener, const struct seccomp_notif *request,
                                struct seccomp_notif_resp *response, const char *root) {
  int syscall_number = request->data.nr;
  char first[PATH_MAX];
  char second[PATH_MAX];
#ifdef __NR_open
  if (syscall_number == __NR_open) {
    if (!resolved_argument(request, AT_FDCWD, 0, 1, root, first)) return 0;
    int flags = (int)request->data.args[1];
    int descriptor = open(first, flags, (mode_t)request->data.args[2]);
    if (descriptor < 0) {
      response->error = -errno;
      return 1;
    }
    struct seccomp_notif_addfd addfd;
    memset(&addfd, 0, sizeof(addfd));
    addfd.id = request->id;
    addfd.srcfd = (uint32_t)descriptor;
    addfd.newfd_flags = (flags & O_CLOEXEC) ? O_CLOEXEC : 0;
    int injected = ioctl(listener, SECCOMP_IOCTL_NOTIF_ADDFD, &addfd);
    int saved_errno = errno;
    close(descriptor);
    if (injected < 0) response->error = -saved_errno;
    else response->val = injected;
    return 1;
  }
#endif
#ifdef __NR_openat
  if (syscall_number == __NR_openat) {
    if (!resolved_argument(request, (int)request->data.args[0], 1, 1, root, first)) return 0;
    int flags = (int)request->data.args[2];
    int descriptor = open(first, flags, (mode_t)request->data.args[3]);
    if (descriptor < 0) {
      response->error = -errno;
      return 1;
    }
    struct seccomp_notif_addfd addfd;
    memset(&addfd, 0, sizeof(addfd));
    addfd.id = request->id;
    addfd.srcfd = (uint32_t)descriptor;
    addfd.newfd_flags = (flags & O_CLOEXEC) ? O_CLOEXEC : 0;
    int injected = ioctl(listener, SECCOMP_IOCTL_NOTIF_ADDFD, &addfd);
    int saved_errno = errno;
    close(descriptor);
    if (injected < 0) response->error = -saved_errno;
    else response->val = injected;
    return 1;
  }
#endif
#ifdef __NR_mkdir
  if (syscall_number == __NR_mkdir) {
    if (!resolved_argument(request, AT_FDCWD, 0, 0, root, first)) return 0;
    response_from_result(response, mkdir(first, (mode_t)request->data.args[1]));
    return 1;
  }
#endif
#ifdef __NR_mkdirat
  if (syscall_number == __NR_mkdirat) {
    if (!resolved_argument(request, (int)request->data.args[0], 1, 0, root, first)) return 0;
    response_from_result(response, mkdir(first, (mode_t)request->data.args[2]));
    return 1;
  }
#endif
#ifdef __NR_unlink
  if (syscall_number == __NR_unlink) {
    if (!resolved_argument(request, AT_FDCWD, 0, 0, root, first)) return 0;
    response_from_result(response, unlink(first));
    return 1;
  }
#endif
#ifdef __NR_unlinkat
  if (syscall_number == __NR_unlinkat) {
    if (!resolved_argument(request, (int)request->data.args[0], 1, 0, root, first)) return 0;
    int flags = (int)request->data.args[2];
    response_from_result(response, (flags & AT_REMOVEDIR) ? rmdir(first) : unlink(first));
    return 1;
  }
#endif
#ifdef __NR_rmdir
  if (syscall_number == __NR_rmdir) {
    if (!resolved_argument(request, AT_FDCWD, 0, 0, root, first)) return 0;
    response_from_result(response, rmdir(first));
    return 1;
  }
#endif
#ifdef __NR_rename
  if (syscall_number == __NR_rename) {
    if (!resolved_argument(request, AT_FDCWD, 0, 0, root, first) ||
        !resolved_argument(request, AT_FDCWD, 1, 0, root, second)) return 0;
    response_from_result(response, rename(first, second));
    return 1;
  }
#endif
#ifdef __NR_renameat
  if (syscall_number == __NR_renameat) {
    if (!resolved_argument(request, (int)request->data.args[0], 1, 0, root, first) ||
        !resolved_argument(request, (int)request->data.args[2], 3, 0, root, second)) return 0;
    response_from_result(response, rename(first, second));
    return 1;
  }
#endif
#ifdef __NR_renameat2
  if (syscall_number == __NR_renameat2) {
    if (!resolved_argument(request, (int)request->data.args[0], 1, 0, root, first) ||
        !resolved_argument(request, (int)request->data.args[2], 3, 0, root, second)) return 0;
    response_from_result(response, (int)syscall(__NR_renameat2, AT_FDCWD, first,
                                                AT_FDCWD, second, request->data.args[4]));
    return 1;
  }
#endif
#ifdef __NR_link
  if (syscall_number == __NR_link) {
    if (!resolved_argument(request, AT_FDCWD, 0, 1, root, first) ||
        !resolved_argument(request, AT_FDCWD, 1, 0, root, second)) return 0;
    response_from_result(response, link(first, second));
    return 1;
  }
#endif
#ifdef __NR_linkat
  if (syscall_number == __NR_linkat) {
    if (!resolved_argument(request, (int)request->data.args[0], 1, 1, root, first) ||
        !resolved_argument(request, (int)request->data.args[2], 3, 0, root, second)) return 0;
    response_from_result(response, link(first, second));
    return 1;
  }
#endif
#ifdef __NR_symlink
  if (syscall_number == __NR_symlink) {
    if (read_remote_string((pid_t)request->pid, request->data.args[0], first, sizeof(first)) != 0 ||
        !resolved_argument(request, AT_FDCWD, 1, 0, root, second)) return 0;
    response_from_result(response, symlink(first, second));
    return 1;
  }
#endif
#ifdef __NR_symlinkat
  if (syscall_number == __NR_symlinkat) {
    if (read_remote_string((pid_t)request->pid, request->data.args[0], first, sizeof(first)) != 0 ||
        !resolved_argument(request, (int)request->data.args[1], 2, 0, root, second)) return 0;
    response_from_result(response, symlink(first, second));
    return 1;
  }
#endif
  return 0;
}

static volatile sig_atomic_t forwarded_child_group = -1;

static void forward_termination_signal(int signal_number) {
  pid_t child_group = (pid_t)forwarded_child_group;
  if (child_group > 0) kill(-child_group, signal_number);
}

static void install_signal_forwarding(pid_t child) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_termination_signal;
  sigemptyset(&action.sa_mask);
  forwarded_child_group = (sig_atomic_t)child;
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
}

static int open_user_terminal(int *master_output, int *slave_output) {
  int master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (master < 0) return -1;
  if (grantpt(master) != 0 || unlockpt(master) != 0) {
    close(master);
    return -1;
  }
  const char *slave_name = ptsname(master);
  if (!slave_name) {
    close(master);
    return -1;
  }
  int slave = open(slave_name, O_RDWR | O_CLOEXEC);
  if (slave < 0) {
    close(master);
    return -1;
  }

  struct termios attributes;
  if (tcgetattr(slave, &attributes) == 0) {
    attributes.c_oflag &= (tcflag_t)~ONLCR;
    tcsetattr(slave, TCSANOW, &attributes);
  }
  struct winsize dimensions;
  memset(&dimensions, 0, sizeof(dimensions));
  dimensions.ws_row = 24;
  dimensions.ws_col = 80;
  ioctl(slave, TIOCSWINSZ, &dimensions);
  ioctl(slave, TIOCSCTTY, 0);

  *master_output = master;
  *slave_output = slave;
  return 0;
}

static int write_complete(int descriptor, const char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, buffer + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
}

static int relay_once(int input, int output) {
  char buffer[8192];
  ssize_t count = read(input, buffer, sizeof(buffer));
  if (count > 0) return write_complete(output, buffer, (size_t)count) == 0 ? 1 : -1;
  if (count == 0 || (count < 0 && errno == EIO)) return 0;
  if (errno == EINTR || errno == EAGAIN) return 1;
  return -1;
}

static int service_seccomp_notification(int listener, const char *root) {
  struct seccomp_notif request;
  struct seccomp_notif_resp response;
  memset(&request, 0, sizeof(request));
  memset(&response, 0, sizeof(response));
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &request) != 0) {
    return (errno == EINTR || errno == ENOENT) ? 0 : -1;
  }
  response.id = request.id;
  if (!notification_allowed(&request, root) ||
      !emulate_notification(listener, &request, &response, root)) {
    response.error = -EROFS;
  }
  if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &response) != 0 && errno != ENOENT) return -1;
  return 0;
}

static int monitor_child(int listener, pid_t child, const char *root, int terminal_fd) {
  int status = 0;
  int child_done = 0;
  int child_group_stopped = 0;
  int terminal_open = terminal_fd >= 0;
  int input_open = terminal_fd >= 0;

  while (!child_done || terminal_open) {
    if (!child_done) {
      pid_t waited = waitpid(child, &status, WNOHANG);
      if (waited == child) {
        child_done = 1;
        if (terminal_fd >= 0 && !child_group_stopped) {
          kill(-child, SIGTERM);
          child_group_stopped = 1;
        }
      } else if (waited < 0 && errno != EINTR) {
        return 125;
      }
    }
    if (child_done && !terminal_open) break;

    struct pollfd descriptors[3];
    int descriptor_count = 0;
    int listener_index = -1;
    int terminal_index = -1;
    int input_index = -1;
    if (!child_done) {
      listener_index = descriptor_count;
      descriptors[descriptor_count++] = (struct pollfd){ .fd = listener, .events = POLLIN | POLLHUP };
    }
    if (terminal_open) {
      terminal_index = descriptor_count;
      descriptors[descriptor_count++] = (struct pollfd){ .fd = terminal_fd, .events = POLLIN | POLLHUP };
    }
    if (!child_done && input_open) {
      input_index = descriptor_count;
      descriptors[descriptor_count++] = (struct pollfd){ .fd = STDIN_FILENO, .events = POLLIN | POLLHUP };
    }

    int ready = poll(descriptors, (nfds_t)descriptor_count, 250);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return 125;
    }
    if (ready == 0) continue;

    if (listener_index >= 0 && (descriptors[listener_index].revents & POLLIN) &&
        service_seccomp_notification(listener, root) != 0) {
      return 125;
    }
    if (terminal_index >= 0 && (descriptors[terminal_index].revents & POLLIN)) {
      int relayed = relay_once(terminal_fd, STDOUT_FILENO);
      if (relayed < 0) return 125;
      if (relayed == 0) terminal_open = 0;
    }
    if (terminal_open && terminal_index >= 0 &&
        (descriptors[terminal_index].revents & (POLLHUP | POLLERR | POLLNVAL))) {
      while (terminal_open) {
        int relayed = relay_once(terminal_fd, STDOUT_FILENO);
        if (relayed < 0) return 125;
        if (relayed == 0) terminal_open = 0;
      }
    }
    if (input_index >= 0 && (descriptors[input_index].revents & POLLIN)) {
      int relayed = relay_once(STDIN_FILENO, terminal_fd);
      if (relayed < 0) return 125;
      if (relayed == 0) input_open = 0;
    }
    if (input_index >= 0 && (descriptors[input_index].revents & (POLLHUP | POLLERR | POLLNVAL))) {
      input_open = 0;
    }
  }

  if (!child_done) {
    while (waitpid(child, &status, 0) < 0) {
      if (errno != EINTR) return 125;
    }
  }
  if (terminal_fd >= 0 && !child_group_stopped) kill(-child, SIGTERM);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: codex-readonly-runner command [args...]\n");
    return 125;
  }
  const char *configured_root = getenv("CODEX_IDE_WRITABLE_TMP");
  char writable_root[PATH_MAX];
  writable_root[0] = '\0';
  if (configured_root && !realpath(configured_root, writable_root)) {
    perror("codex-readonly-runner temp");
    return 126;
  }

  if (getenv("CODEX_IDE_DISPOSABLE_WORKSPACE")) {
    if (install_filter(1) != 0) {
      perror("codex-readonly-runner");
      return 126;
    }
    execvp(argv[1], &argv[1]);
    perror("codex-readonly-runner exec");
    return 127;
  }

  int use_user_terminal = getenv("CODEX_IDE_USER_CONSOLE") != NULL;
  int terminal_master = -1;
  int terminal_slave = -1;
  if (use_user_terminal && open_user_terminal(&terminal_master, &terminal_slave) != 0) {
    perror("codex-readonly-runner terminal");
    return 126;
  }

  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sockets) != 0) {
    if (terminal_master >= 0) close(terminal_master);
    if (terminal_slave >= 0) close(terminal_slave);
    perror("codex-readonly-runner socketpair");
    return 126;
  }
  pid_t child = fork();
  if (child < 0) {
    close(sockets[0]);
    close(sockets[1]);
    if (terminal_master >= 0) close(terminal_master);
    if (terminal_slave >= 0) close(terminal_slave);
    perror("codex-readonly-runner fork");
    return 126;
  }
  if (child == 0) {
    if (use_user_terminal) {
      close(terminal_master);
      if (setpgid(0, 0) != 0 ||
          dup2(terminal_slave, STDIN_FILENO) < 0 ||
          dup2(terminal_slave, STDOUT_FILENO) < 0 ||
          dup2(terminal_slave, STDERR_FILENO) < 0) {
        perror("codex-readonly-runner terminal child");
        _exit(126);
      }
      if (terminal_slave > STDERR_FILENO) close(terminal_slave);
    }
    close(sockets[0]);
    int listener = install_filter(0);
    if (listener < 0 || send_fd(sockets[1], listener) != 0) {
      perror("codex-readonly-runner seccomp");
      _exit(126);
    }
    close(listener);
    close(sockets[1]);
    execvp(argv[1], &argv[1]);
    perror("codex-readonly-runner exec");
    _exit(127);
  }

  if (use_user_terminal) {
    if (setpgid(child, child) != 0 && errno != EACCES && errno != ESRCH) {
      kill(child, SIGTERM);
      waitpid(child, NULL, 0);
      close(sockets[0]);
      close(sockets[1]);
      close(terminal_master);
      close(terminal_slave);
      perror("codex-readonly-runner process group");
      return 126;
    }
    signal(SIGTTOU, SIG_IGN);
    if (tcsetpgrp(terminal_slave, child) != 0) {
      kill(-child, SIGTERM);
      waitpid(child, NULL, 0);
      close(sockets[0]);
      close(sockets[1]);
      close(terminal_master);
      close(terminal_slave);
      perror("codex-readonly-runner foreground terminal");
      return 126;
    }
    close(terminal_slave);
    terminal_slave = -1;
    install_signal_forwarding(child);
  }

  close(sockets[1]);
  int listener = receive_fd(sockets[0]);
  close(sockets[0]);
  if (listener < 0) {
    if (use_user_terminal) kill(-child, SIGTERM);
    else kill(child, SIGTERM);
    waitpid(child, NULL, 0);
    if (terminal_master >= 0) close(terminal_master);
    forwarded_child_group = -1;
    fprintf(stderr, "codex-readonly-runner: listener unavailable\n");
    return 126;
  }
  int result = monitor_child(listener, child, writable_root, terminal_master);
  forwarded_child_group = -1;
  close(listener);
  if (terminal_master >= 0) close(terminal_master);
  return result;
}
