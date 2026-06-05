#include <pthread.h>
#include <stdint.h>
#include <stdio.h>

static volatile int completed = 0;

static void *worker(void *arg) {
    uintptr_t n = (uintptr_t)arg;
    completed++;
    return (void *)(n + 1000);
}

int main(void) {
    for (uintptr_t i = 0; i < 64; i++) {
        pthread_t thread;
        void *ret = NULL;

        int rc = pthread_create(&thread, NULL, worker, (void *)i);
        if (rc != 0) {
            printf("FAIL: pthread_create iteration %lu returned %d\n", (unsigned long)i, rc);
            return 1;
        }

        rc = pthread_join(thread, &ret);
        if (rc != 0) {
            printf("FAIL: pthread_join iteration %lu returned %d\n", (unsigned long)i, rc);
            return 1;
        }

        uintptr_t got = (uintptr_t)ret;
        uintptr_t expected = i + 1000;
        if (got != expected) {
            printf("FAIL: iteration %lu returned %lu expected %lu\n",
                   (unsigned long)i, (unsigned long)got, (unsigned long)expected);
            return 1;
        }
    }

    if (completed != 64) {
        printf("FAIL: completed=%d expected 64\n", completed);
        return 1;
    }

    printf("thread slot reuse ok\n");
    printf("PASS\n");
    return 0;
}
