#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static int fail_with_file_bytes(const char *label, const char *bytes) {
    fprintf(stderr, "%s: file bytes changed to '%c%c%c%c'\n",
            label, bytes[0], bytes[1], bytes[2], bytes[3]);
    return 1;
}

int main(void) {
    const char *path = "/tmp/mmap_shared_munmap_reuse";
    const char shared_bytes[4] = {'S', 'H', 'R', 'D'};
    const char anon_bytes[4] = {'A', 'N', 'O', 'N'};

    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0) {
        perror("sysconf");
        return 1;
    }

    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) {
        perror("open");
        return 1;
    }
    if (ftruncate(fd, page_size) < 0) {
        perror("ftruncate");
        return 1;
    }

    char *shared = mmap(NULL, page_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (shared == MAP_FAILED) {
        perror("mmap shared");
        return 1;
    }

    memcpy(shared, shared_bytes, sizeof(shared_bytes));
    if (msync(shared, page_size, MS_SYNC) < 0) {
        perror("msync shared");
        return 1;
    }

    if (munmap(shared, page_size / 2) < 0) {
        perror("partial munmap shared");
        return 1;
    }

    char *anon = mmap(shared, page_size, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
    if (anon == MAP_FAILED) {
        perror("mmap anonymous fixed");
        return 1;
    }
    if (anon != shared) {
        fprintf(stderr, "anonymous mapping did not reuse address: got %p expected %p\n",
                anon, shared);
        return 1;
    }

    if (anon[0] != 0 || anon[1] != 0 || anon[2] != 0 || anon[3] != 0) {
        fprintf(stderr, "anonymous mapping was not zeroed: '%c%c%c%c'\n",
                anon[0], anon[1], anon[2], anon[3]);
        return 1;
    }

    memcpy(anon, anon_bytes, sizeof(anon_bytes));
    (void)getpid();

    if (munmap(anon, page_size) < 0) {
        perror("munmap anonymous");
        return 1;
    }

    char file_bytes[4] = {0};
    if (lseek(fd, 0, SEEK_SET) < 0) {
        perror("lseek");
        return 1;
    }
    if (read(fd, file_bytes, sizeof(file_bytes)) != (ssize_t)sizeof(file_bytes)) {
        perror("read");
        return 1;
    }
    if (memcmp(file_bytes, shared_bytes, sizeof(shared_bytes)) != 0) {
        return fail_with_file_bytes("stale shared mapping survived partial munmap", file_bytes);
    }

    close(fd);
    unlink(path);
    printf("partial munmap cleanup ok\n");
    printf("PASS\n");
    return 0;
}
