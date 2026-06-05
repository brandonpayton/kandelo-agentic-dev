
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>

int main(void) {
    const char *path = "/tmp/mmap_shared_test";

    // Create a file and extend to page size
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    long pagesize = sysconf(_SC_PAGESIZE);
    if (pagesize < 0) { perror("sysconf"); return 1; }
    printf("pagesize: %ld\n", pagesize);

    if (ftruncate(fd, pagesize) < 0) { perror("ftruncate"); return 1; }

    // mmap MAP_SHARED
    char *ptr = mmap(NULL, pagesize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) { perror("mmap"); return 1; }
    printf("mmap ok at %p\n", ptr);

    // Write through the mapping
    ptr[0] = 'x';
    ptr[1] = 'y';
    ptr[2] = 'z';

    // msync to flush back to file
    if (msync(ptr, pagesize, MS_SYNC) < 0) { perror("msync"); return 1; }
    printf("msync ok\n");

    // Read from the fd to verify the data was written back
    lseek(fd, 0, SEEK_SET);
    char buf[4] = {0};
    if (read(fd, buf, 3) != 3) { perror("read"); return 1; }

    if (buf[0] != 'x' || buf[1] != 'y' || buf[2] != 'z') {
        fprintf(stderr, "msync writeback failed: got '%c%c%c'\n", buf[0], buf[1], buf[2]);
        return 1;
    }
    printf("read back: %c%c%c\n", buf[0], buf[1], buf[2]);

    // Also test: write more data, munmap, and verify MAP_SHARED writes remain
    // coherent with the underlying file once the mapping is torn down.
    ptr[3] = 'w';
    if (munmap(ptr, pagesize) < 0) { perror("munmap"); return 1; }

    lseek(fd, 0, SEEK_SET);
    char buf4[5] = {0};
    if (read(fd, buf4, 4) != 4) { perror("read after munmap"); return 1; }
    if (memcmp(buf4, "xyzw", 4) != 0) {
        fprintf(stderr, "munmap writeback failed: got '%c%c%c%c'\n", buf4[0], buf4[1], buf4[2], buf4[3]);
        return 1;
    }
    printf("read after munmap: %c%c%c%c\n", buf4[0], buf4[1], buf4[2], buf4[3]);

    if (ftruncate(fd, pagesize * 2) < 0) { perror("ftruncate grow"); return 1; }
    ptr = mmap(NULL, pagesize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) { perror("mmap remap"); return 1; }
    char *grown = mremap(ptr, pagesize, pagesize * 2, MREMAP_MAYMOVE);
    if (grown == MAP_FAILED) { perror("mremap"); return 1; }
    printf("mremap ok\n");
    if (munmap(grown, pagesize * 2) < 0) { perror("munmap grown"); return 1; }

    close(fd);
    unlink(path);
    printf("PASS\n");
    return 0;
}
