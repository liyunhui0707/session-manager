#define _DARWIN_C_SOURCE 1

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define MAX_ROOT 4096U
#define MAX_RELATIVE 4096U
#define MAX_INDEX (1024U * 1024U)
#define MAX_ENTRIES 50000U
#define MAX_VISITED 250000U
#define MAX_DEPTH 64U

enum { FRAME_PROBE = 1, FRAME_ENTRY = 2, FRAME_INDEX = 3, FRAME_COMPLETE = 4 };
enum { STATUS_MISSING = 0, STATUS_SAFE = 1, STATUS_UNSAFE = 2, STATUS_ERROR = 3 };
enum { AREA_ACTIVE = 0, AREA_ARCHIVE = 1 };

enum { SKIP_COMPRESSED, SKIP_NAME, SKIP_LAYOUT, SKIP_UNSAFE, SKIP_OTHER, SKIP_TYPES };
static uint32_t skip_reasons[SKIP_TYPES];
static uint32_t skipped_count;

static void skip_entry(unsigned reason) {
  skipped_count++;
  skip_reasons[reason]++;
}

static unsigned unsupported_name_reason(const char *name) {
  size_t length = strlen(name);
  if (strncmp(name, "rollout-", 8) != 0) return SKIP_OTHER;
  if (length >= 10 && strcmp(name + length - 10, ".jsonl.zst") == 0) return SKIP_COMPRESSED;
  return SKIP_NAME;
}
static uint32_t visited_count;
static uint32_t entry_count;

#ifdef ASM_TESTING
static char swapped_target[MAX_ROOT + 32];
static char swapped_saved[MAX_ROOT + 48];
static int swap_active;

static void restore_swap(void) {
  if (!swap_active) return;
  (void)unlink(swapped_target);
  (void)rename(swapped_saved, swapped_target);
  swap_active = 0;
}

static int maybe_swap(const char *relative, const char *root) {
  const char *target = getenv("ASM_TEST_SWAP_TARGET");
  const char *outside = getenv("ASM_TEST_SWAP_OUTSIDE");
  char expected[MAX_ROOT + 32];
  if (!target || !outside || swap_active) return 0;
  if (snprintf(expected, sizeof(expected), "%s/%s", root, relative) < 0 || strcmp(expected, target) != 0) return 0;
  if (snprintf(swapped_target, sizeof(swapped_target), "%s", target) < 0 ||
      snprintf(swapped_saved, sizeof(swapped_saved), "%s.asm-saved", target) < 0) return -1;
  if (rename(swapped_target, swapped_saved) != 0) return -1;
  if (symlink(outside, swapped_target) != 0) {
    (void)rename(swapped_saved, swapped_target);
    return -1;
  }
  swap_active = 1;
  return 0;
}
#else
static void restore_swap(void) {}
static int maybe_swap(const char *relative, const char *root) {
  (void)relative;
  (void)root;
  return 0;
}
#endif

static uint32_t be32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

static void put32(unsigned char *p, uint32_t value) {
  p[0] = (unsigned char)(value >> 24);
  p[1] = (unsigned char)(value >> 16);
  p[2] = (unsigned char)(value >> 8);
  p[3] = (unsigned char)value;
}

static void put64(unsigned char *p, uint64_t value) {
  for (int index = 7; index >= 0; index--) {
    p[index] = (unsigned char)value;
    value >>= 8;
  }
}

static int read_exact(int fd, void *buffer, size_t length) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count == 0) return -1;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static int write_exact(int fd, const void *buffer, size_t length) {
  const unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t count = write(fd, cursor, length);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static int write_frame(unsigned char type, const void *payload, uint32_t length) {
  unsigned char header[5];
  header[0] = type;
  put32(header + 1, length);
  if (write_exact(STDOUT_FILENO, header, sizeof(header)) != 0) return -1;
  return length == 0 ? 0 : write_exact(STDOUT_FILENO, payload, length);
}

static int safe_component(const char *name) {
  return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static int open_canonical_root(const char *root) {
  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  char copy[MAX_ROOT + 1];
  char *cursor;
  if (current < 0) return -1;
  if (strcmp(root, "/") == 0) return current;
  memcpy(copy, root + 1, strlen(root));
  copy[strlen(root) - 1] = '\0';
  cursor = copy;
  while (*cursor) {
    char *slash = strchr(cursor, '/');
    int next;
    if (slash) *slash = '\0';
    if (!safe_component(cursor)) { close(current); return -1; }
    next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next < 0) return -1;
    current = next;
    if (!slash) break;
    cursor = slash + 1;
  }
  return current;
}

static unsigned char probe_directory(int root_fd, const char *name, int *opened_fd) {
  int fd = openat(root_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd >= 0) { *opened_fd = fd; return STATUS_SAFE; }
  if (errno == ENOENT) return STATUS_MISSING;
  if (errno == ELOOP || errno == ENOTDIR) return STATUS_UNSAFE;
  return STATUS_ERROR;
}

static unsigned char probe_index(int root_fd) {
  struct stat info;
  if (fstatat(root_fd, "session_index.jsonl", &info, AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(info.st_mode) || info.st_size < 0 || (uint64_t)info.st_size > MAX_INDEX) return STATUS_UNSAFE;
    return STATUS_SAFE;
  }
  if (errno == ENOENT) return STATUS_MISSING;
  if (errno == ELOOP || errno == ENOTDIR) return STATUS_UNSAFE;
  return STATUS_ERROR;
}

static int valid_digits(const char *value, size_t length) {
  if (strlen(value) != length) return 0;
  for (size_t index = 0; index < length; index++) if (value[index] < '0' || value[index] > '9') return 0;
  return 1;
}

static int valid_month(const char *value) {
  return valid_digits(value, 2) && value[0] >= '0' && value[0] <= '1' &&
    (value[0] == '0' ? value[1] >= '1' : value[1] <= '2');
}

static int valid_day(const char *value) {
  if (!valid_digits(value, 2)) return 0;
  int day = (value[0] - '0') * 10 + value[1] - '0';
  return day >= 1 && day <= 31;
}

static int hex_char(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

static int valid_rollout(const char *name) {
  static const char prefix[] = "rollout-";
  size_t length = strlen(name);
  if ((length != 70 && length != 74) || memcmp(name, prefix, sizeof(prefix) - 1) != 0 || name[27] != '-' ||
      (strcmp(name + 64, ".jsonl") != 0 && strcmp(name + 64, ".jsonl.zst") != 0)) return 0;
  for (size_t index = 8; index < 27; index++) {
    int separator = index == 12 || index == 15 || index == 18 || index == 21 || index == 24;
    char expected = index == 18 ? 'T' : '-';
    if (separator ? name[index] != expected : (name[index] < '0' || name[index] > '9')) return 0;
  }
  for (size_t index = 28; index < 64; index++) {
    int separator = index == 36 || index == 41 || index == 46 || index == 51;
    if (separator ? name[index] != '-' : !hex_char(name[index])) return 0;
  }
  return 1;
}

static int emit_entry(unsigned char area, const char *relative, const struct stat *info) {
  unsigned char *payload;
  size_t path_length = strlen(relative);
  uint64_t seconds;
  uint32_t nanoseconds;
  if (path_length == 0 || path_length > MAX_RELATIVE || entry_count >= MAX_ENTRIES || info->st_size < 0) return -1;
  payload = malloc(25 + path_length);
  if (!payload) return -1;
  seconds = (uint64_t)info->st_mtimespec.tv_sec;
  nanoseconds = (uint32_t)info->st_mtimespec.tv_nsec;
  payload[0] = area;
  put64(payload + 1, (uint64_t)info->st_size);
  put64(payload + 9, seconds);
  put32(payload + 17, nanoseconds);
  put32(payload + 21, (uint32_t)path_length);
  memcpy(payload + 25, relative, path_length);
  int result = write_frame(FRAME_ENTRY, payload, (uint32_t)(25 + path_length));
  free(payload);
  if (result == 0) entry_count++;
  return result;
}

static DIR *directory_stream(int fd) {
  int duplicate = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return NULL;
  DIR *directory = fdopendir(duplicate);
  if (!directory) close(duplicate);
  return directory;
}

static int open_child(int parent_fd, const char *name) {
  return openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

static int join_relative(char *output, size_t capacity, const char *parent, const char *name) {
  int length = parent[0] ? snprintf(output, capacity, "%s/%s", parent, name) : snprintf(output, capacity, "%s", name);
  return length >= 0 && (size_t)length < capacity ? 0 : -1;
}

static int scan_active_level(int fd, const char *relative, const char *root, unsigned level) {
  DIR *directory = directory_stream(fd);
  struct dirent *item;
  if (!directory) return -1;
  for (;;) {
    char child_relative[MAX_RELATIVE + 1];
    struct stat info;
    errno = 0;
    item = readdir(directory);
    if (!item) {
      int read_error = errno;
      int close_error = closedir(directory);
      return read_error == 0 && close_error == 0 ? 0 : -1;
    }
    if (strcmp(item->d_name, ".") == 0 || strcmp(item->d_name, "..") == 0) continue;
    if (++visited_count > MAX_VISITED || !safe_component(item->d_name) ||
        join_relative(child_relative, sizeof(child_relative), relative, item->d_name) != 0) {
      closedir(directory); return -1;
    }
    if (level < 3) {
      int valid = level == 0 ? valid_digits(item->d_name, 4) : level == 1 ? valid_month(item->d_name) : valid_day(item->d_name);
      if (!valid) { skip_entry(SKIP_LAYOUT); continue; }
      int child = open_child(fd, item->d_name);
      if (child < 0) {
        if (errno == ENOENT || errno == ELOOP || errno == ENOTDIR) { skip_entry(SKIP_UNSAFE); continue; }
        closedir(directory); return -1;
      }
      if (maybe_swap(child_relative, root) != 0 || scan_active_level(child, child_relative, root, level + 1) != 0) {
        close(child); closedir(directory); return -1;
      }
      close(child);
      continue;
    }
    if (fstatat(fd, item->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT || errno == ELOOP) { skip_entry(SKIP_UNSAFE); continue; }
      closedir(directory); return -1;
    }
    if (!S_ISREG(info.st_mode)) { skip_entry(SKIP_UNSAFE); continue; }
    if (!valid_rollout(item->d_name)) { skip_entry(unsupported_name_reason(item->d_name)); continue; }
    if (emit_entry(AREA_ACTIVE, child_relative, &info) != 0) { closedir(directory); return -1; }
  }
}

static int scan_archive(int fd, const char *relative, const char *root, unsigned depth) {
  DIR *directory;
  struct dirent *item;
  if (depth > MAX_DEPTH) return -1;
  directory = directory_stream(fd);
  if (!directory) return -1;
  for (;;) {
    char child_relative[MAX_RELATIVE + 1];
    struct stat info;
    errno = 0;
    item = readdir(directory);
    if (!item) {
      int read_error = errno;
      int close_error = closedir(directory);
      return read_error == 0 && close_error == 0 ? 0 : -1;
    }
    if (strcmp(item->d_name, ".") == 0 || strcmp(item->d_name, "..") == 0) continue;
    if (++visited_count > MAX_VISITED || !safe_component(item->d_name) ||
        join_relative(child_relative, sizeof(child_relative), relative, item->d_name) != 0) {
      closedir(directory); return -1;
    }
    if (fstatat(fd, item->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT || errno == ELOOP) { skip_entry(SKIP_UNSAFE); continue; }
      closedir(directory); return -1;
    }
    if (S_ISDIR(info.st_mode)) {
      int child = open_child(fd, item->d_name);
      if (child < 0) {
        if (errno == ENOENT || errno == ELOOP || errno == ENOTDIR) { skip_entry(SKIP_UNSAFE); continue; }
        closedir(directory); return -1;
      }
      if (maybe_swap(child_relative, root) != 0 || scan_archive(child, child_relative, root, depth + 1) != 0) {
        close(child); closedir(directory); return -1;
      }
      close(child);
    } else if (S_ISREG(info.st_mode) && valid_rollout(item->d_name)) {
      if (emit_entry(AREA_ARCHIVE, child_relative, &info) != 0) { closedir(directory); return -1; }
    } else {
      skip_entry(S_ISREG(info.st_mode) ? unsupported_name_reason(item->d_name) : SKIP_UNSAFE);
    }
  }
}

static int emit_index(int root_fd) {
  int fd = openat(root_fd, "session_index.jsonl", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  struct stat info;
  unsigned char *content;
  int result;
  if (fd < 0) return 0;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0 || (uint64_t)info.st_size > MAX_INDEX) {
    close(fd); return 0;
  }
  content = malloc(info.st_size == 0 ? 1U : (size_t)info.st_size);
  if (!content) { close(fd); return -1; }
#ifdef ASM_TESTING
  if (getenv("ASM_TEST_INDEX_READ_ERROR")) { close(fd); fd = -1; }
#endif
  result = read_exact(fd, content, (size_t)info.st_size);
  if (fd >= 0) close(fd);
  if (result != 0) { free(content); return 0; }
  result = write_frame(FRAME_INDEX, content, (uint32_t)info.st_size);
  free(content);
  return result == 0 ? 0 : -1;
}

static int emit_complete(void) {
  struct rusage usage;
  unsigned char payload[36];
  uint64_t peak = 0;
  if (getrusage(RUSAGE_SELF, &usage) == 0 && usage.ru_maxrss > 0) peak = (uint64_t)usage.ru_maxrss;
  put32(payload, skipped_count);
  put32(payload + 4, visited_count);
  put64(payload + 8, peak);
  for (unsigned i = 0; i < SKIP_TYPES; i++) put32(payload + 16 + i * 4, skip_reasons[i]);
  return write_frame(FRAME_COMPLETE, payload, sizeof(payload));
}

int main(void) {
  unsigned char input_header[9];
  unsigned char output_magic[5] = { 'A', 'S', 'M', 'O', 2 };
  unsigned char probe[3];
  unsigned char plan[6];
  char root[MAX_ROOT + 1];
  int root_fd = -1, sessions_fd = -1, archive_fd = -1;
  int result = 1;
  int failure_stage = 1;

  if (read_exact(STDIN_FILENO, input_header, sizeof(input_header)) != 0 ||
      memcmp(input_header, "ASMI\2", 5) != 0) goto done;
  failure_stage = 2;
  uint32_t root_length = be32(input_header + 5);
  if (root_length == 0 || root_length > MAX_ROOT || read_exact(STDIN_FILENO, root, root_length) != 0) goto done;
  root[root_length] = '\0';
  if (root[0] != '/' || strchr(root, '\0') != root + root_length) goto done;
  root_fd = open_canonical_root(root);
  if (root_fd < 0) goto done;
  failure_stage = 3;

  probe[0] = probe_directory(root_fd, "sessions", &sessions_fd);
  probe[1] = probe_directory(root_fd, "archived_sessions", &archive_fd);
  probe[2] = probe_index(root_fd);
  if (write_exact(STDOUT_FILENO, output_magic, sizeof(output_magic)) != 0 ||
      write_frame(FRAME_PROBE, probe, sizeof(probe)) != 0) goto done;
  failure_stage = 4;
  if (read_exact(STDIN_FILENO, plan, sizeof(plan)) != 0 || memcmp(plan, "ASMP\2", 5) != 0) goto done;

  if (plan[5] == 1) {
    failure_stage = 5;
    if (probe[0] != STATUS_SAFE || probe[1] == STATUS_ERROR) goto done;
    failure_stage = 6;
    if (scan_active_level(sessions_fd, "sessions", root, 0) != 0) goto done;
    failure_stage = 7;
    if (probe[1] == STATUS_SAFE && scan_archive(archive_fd, "archived_sessions", root, 0) != 0) goto done;
    failure_stage = 8;
    if (probe[2] == STATUS_SAFE && emit_index(root_fd) != 0) goto done;
  } else if (plan[5] == 0) {
    failure_stage = 9;
    if (probe[0] != STATUS_MISSING || scan_active_level(root_fd, "", root, 0) != 0) goto done;
  } else {
    goto done;
  }
  failure_stage = 10;
  if (emit_complete() != 0) goto done;
  result = 0;

done:
  if (result != 0) (void)dprintf(STDERR_FILENO, "%d\n", failure_stage);
  restore_swap();
  if (sessions_fd >= 0) close(sessions_fd);
  if (archive_fd >= 0) close(archive_fd);
  if (root_fd >= 0) close(root_fd);
  return result;
}
