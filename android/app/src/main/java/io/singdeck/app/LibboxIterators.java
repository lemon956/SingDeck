package io.singdeck.app;

import java.util.Collections;
import java.util.Iterator;
import java.util.List;

import io.nekohasekai.libbox.NetworkInterface;
import io.nekohasekai.libbox.NetworkInterfaceIterator;
import io.nekohasekai.libbox.StringIterator;

final class LibboxIterators {
    private LibboxIterators() {}

    static StringIterator strings(List<String> values) {
        List<String> safeValues = values == null ? Collections.emptyList() : values;
        return new StringListIterator(safeValues);
    }

    static NetworkInterfaceIterator interfaces(List<NetworkInterface> values) {
        List<NetworkInterface> safeValues = values == null ? Collections.emptyList() : values;
        return new NetworkInterfaceListIterator(safeValues.iterator());
    }

    private static final class StringListIterator implements StringIterator {
        private final List<String> values;
        private int index;

        private StringListIterator(List<String> values) {
            this.values = values;
        }

        @Override
        public boolean hasNext() {
            return index < values.size();
        }

        @Override
        public int len() {
            return values.size() - index;
        }

        @Override
        public String next() {
            return values.get(index++);
        }
    }

    private static final class NetworkInterfaceListIterator implements NetworkInterfaceIterator {
        private final Iterator<NetworkInterface> iterator;

        private NetworkInterfaceListIterator(Iterator<NetworkInterface> iterator) {
            this.iterator = iterator;
        }

        @Override
        public boolean hasNext() {
            return iterator.hasNext();
        }

        @Override
        public NetworkInterface next() {
            return iterator.next();
        }
    }
}
