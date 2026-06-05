#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
  const char *path = "/tmp/kandelo-mmap-shared-large-pwrite.bin";
  const size_t len = 128 * 1024;

  int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
  if (fd < 0) {
    perror("open");
    return 1;
  }

  if (ftruncate(fd, (off_t)len) != 0) {
    perror("ftruncate");
    return 1;
  }

  unsigned char *mapped = mmap(NULL, len, PROT_READ, MAP_SHARED, fd, 0);
  if (mapped == MAP_FAILED) {
    perror("mmap");
    return 1;
  }

  static unsigned char buf[128 * 1024];
  for (size_t i = 0; i < len; i++) {
    buf[i] = (unsigned char)((i * 131u + 17u) & 0xffu);
  }

  ssize_t n = pwrite(fd, buf, len, 0);
  if (n != (ssize_t)len) {
    perror("pwrite");
    return 1;
  }

  size_t probes[] = {0, 1024, 4096, 65536, len - 1};
  for (size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); i++) {
    size_t off = probes[i];
    if (mapped[off] != buf[off]) {
      fprintf(stderr, "stale mapping at %zu: got=%u want=%u\n",
              off, mapped[off], buf[off]);
      return 1;
    }
  }

  if (munmap(mapped, len) != 0) {
    perror("munmap");
    return 1;
  }
  close(fd);
  unlink(path);

  puts("large pwrite mapping coherent");
  puts("PASS");
  return 0;
}
